import json
import os
import re
import time
from pathlib import Path

import httpx
from typing import Any, Iterator, Callable, Iterable

from dotenv import load_dotenv
from langchain.tools import BaseTool

load_dotenv()

def _require_env(name: str) -> str:
    """
    Zmienna wymagana do działania -- brak wartości przerywa import z czytelnym
    komunikatem zamiast wysyłać błędne żądanie do OpenAI.
    """

    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Brak zmiennej '{name}' w środowisku -- uzupełnij plik .env")

    return value

# OPENAI_BASE_URL pozwala też podpiąć dowolny serwer kompatybilny z OpenAI API
# (np. Azure OpenAI proxy, vLLM, LiteLLM itp.) bez zmiany kodu.
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
OPENAI_API_KEY = _require_env("OPENAI_API_KEY")

LLM_MODEL = _require_env("LLM_MODEL")

# Embeddingi wracają na lokalną Ollamę
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

EMBED_MODEL = _require_env("EMBED_MODEL")
EMBED_MODEL_DIM = int(os.getenv("EMBED_MODEL_DIM", "1024"))

# Poniższe zmienne zostawione bez zmian -- dotyczą bazy grafowej, nie backendu LLM
GRAPH_MODEL = _require_env("GRAPH_MODEL")
GRAPH_DB_URL = os.getenv("GRAPH_DB_URL", "bolt://localhost:7687")
GRAPH_DB_PASSWORD = _require_env("GRAPH_DB_PASSWORD")

PROJECT_ROOT = Path(__file__).resolve().parent.parent

_REASONING_MODEL_PREFIXES = ("o1", "o3", "o4", "gpt-5")


def _is_reasoning_model(model: str) -> bool:
    """
    Modele 'reasoningowe' OpenAI (o1/o3/o4/gpt-5*) nie przyjmują temperature/top_p
    i zamiast tego obsługują parametr 'reasoning_effort'.
    """

    return model.lower().startswith(_REASONING_MODEL_PREFIXES)


def _auth_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }


def _raise_openai_error(response: httpx.Response) -> None:
    """
    OpenAI zwraca przy błędzie JSON w postaci {"error": {"message", "type", "code", ...}}.
    httpx.raise_for_status() tego nie pokazuje, więc wyciągamy to ręcznie, żeby zamiast
    gołego '400 Bad Request' było widać PRAWDZIWY powód (zły parametr, zły typ pola,
    przekroczony limit tokenów itd.).
    """

    try:
        body = response.json()
        detail = body.get("error", {}).get("message") or json.dumps(body, ensure_ascii=False)
    except Exception:
        detail = response.text

    raise RuntimeError(
        f"OpenAI API zwróciło błąd {response.status_code} dla modelu '{LLM_MODEL}':\n{detail}"
    )


_MAX_RATE_LIMIT_RETRIES = 6


def _seconds_until_retry(response: httpx.Response, attempt: int) -> float:
    """
    Wylicza ile poczekać po 429. Najpierw próbujemy standardowego nagłówka
    'Retry-After', potem parsujemy komunikat OpenAI ("Please try again in 4.944s"),
    a w ostateczności robimy exponential backoff.
    """

    retry_after_header = response.headers.get("retry-after")
    if retry_after_header:
        try:
            return float(retry_after_header) + 0.25
        except ValueError:
            pass

    match = re.search(r"try again in ([\d.]+)s", response.text)
    if match:
        return float(match.group(1)) + 0.25

    return min(2 ** attempt, 30.0)


class ChatModel:
    __slots__ = ("model", "system", "memory", "messages", "tools", "tool_functions")

    def __init__(self, model: str,
                 system: str = "",
                 memory: bool = True,
                 tools: Iterable[BaseTool] | None = None) -> None:
        """
        Class that allows for chatting with an OpenAI model of your choosing including
        streaming, memory and tool use.

        :param model: model OpenAI, np. "gpt-4o", "gpt-4o-mini", "o3", "gpt-5"
        :param system: system prompt that explains model how to act. Default: "Jesteś pomocnym asystentem."
        :param memory: do model takes previous messages into consideration. Default: True
        :param tools: lista narzędzi LangChain (@tool) dostępnych dla modelu
        """

        self.model: str = model
        self.system: str = system or "Jesteś pomocnym asystentem."
        self.memory: bool = memory

        tool_list: list[BaseTool] = list(tools) if tools is not None else []
        self.tools: list[dict[str, Any]] = langchain_tools_to_openai_format(tool_list)
        self.tool_functions: dict[str, Callable] = langchain_tools_to_function_map(tool_list)

        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system},
        ]

    def _add_user_message(self, message: str) -> None:
        if self.memory:
            self.messages.append({"role": "user", "content": message})
        else:
            # Jeżeli memory jest wyłączone, zostawiamy tylko system prompt i dodajemy wiadomość użytkownika
            self.messages = [
                self.messages[0],
                {"role": "user", "content": message},
            ]

    def _end_assistant_turn(self) -> None:
        """
        Kończy turę rozmowy. Przy memory=False zostawiamy wyłącznie system prompt --
        wiadomości asystenta i wyniki narzędzi są potrzebne TYLKO w obrębie jednej
        tury (pętla tool-callingu), nie pomiędzy turami.
        """

        if not self.memory:
            self.messages = [self.messages[0]]

    def _build_payload(self, stream: bool, think: bool, options: dict[str, Any] | None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self.messages,
            "stream": stream,
        }

        if self.tools:
            payload["tools"] = self.tools

        if _is_reasoning_model(self.model):
            # Cała rodzina gpt-5.6 (sol/terra/luna) domyślnie "rozumuje", a
            # /v1/chat/completions odrzuca kombinację function tools + jakikolwiek
            # reasoning_effort inny niż "none" (błąd 400: "Function tools with
            # reasoning_effort are not supported ... use /v1/responses or set
            # reasoning_effort to 'none'"). Jeśli mamy narzędzia, wymuszamy "none"
            # niezależnie od 'think' -- inaczej request zawsze się wywali.
            if self.tools:
                payload["reasoning_effort"] = "none"
            elif think:
                payload["reasoning_effort"] = "medium"
        else:
            opts = options if options is not None else {"temperature": 0.1, "top_p": 0.9}
            # 'num_predict'/'num_ctx' to parametry specyficzne dla Ollamy -- mapujemy je,
            # resztę (temperature/top_p itp.) przekazujemy wprost jako top-level pola OpenAI
            for key, value in opts.items():
                if key == "num_predict":
                    if value and value > 0:
                        payload["max_tokens"] = value
                elif key == "num_ctx":
                    continue  # OpenAI nie przyjmuje kontekstu jako parametru requestu
                else:
                    payload[key] = value

        if stream:
            payload["stream_options"] = {"include_usage": True}

        return payload

    def _call_openai(self, think: bool = False, stream: bool = False, options: dict[str, Any] | None = None,
                      timeout: int = 1200) -> dict[str, Any] | Iterator[dict[str, Any]]:
        payload = self._build_payload(stream=stream, think=think, options=options)
        url = f"{OPENAI_BASE_URL}/chat/completions"

        if not stream:
            for attempt in range(_MAX_RATE_LIMIT_RETRIES):
                try:
                    response = httpx.post(url, headers=_auth_headers(), json=payload, timeout=timeout)
                except httpx.TransportError as e:
                    # Chwilowe zerwanie połączenia / błąd DNS (np. Errno 11001 na
                    # Windows) -- nie problem w kodzie, tylko w sieci. Próbujemy ponownie
                    # zamiast wywalać cały (często długi) proces ingestu.
                    if attempt < _MAX_RATE_LIMIT_RETRIES - 1:
                        time.sleep(min(2 ** attempt, 30.0))
                        continue
                    raise RuntimeError(
                        f"Nie udało się połączyć z OpenAI API po {_MAX_RATE_LIMIT_RETRIES} próbach "
                        f"(błąd sieci/DNS): {e}"
                    ) from e

                if response.status_code == 429 and attempt < _MAX_RATE_LIMIT_RETRIES - 1:
                    time.sleep(_seconds_until_retry(response, attempt))
                    continue

                if response.status_code >= 400:
                    _raise_openai_error(response)

                return response.json()

            raise RuntimeError("OpenAI API: przekroczono limit prób po wielokrotnych błędach 429 (rate limit)")

        def response_generator() -> Iterator[dict[str, Any]]:
            for attempt in range(_MAX_RATE_LIMIT_RETRIES):
                try:
                    stream_ctx = httpx.stream("POST", url, headers=_auth_headers(), json=payload, timeout=timeout)
                    response = stream_ctx.__enter__()
                except httpx.TransportError as e:
                    if attempt < _MAX_RATE_LIMIT_RETRIES - 1:
                        time.sleep(min(2 ** attempt, 30.0))
                        continue
                    raise RuntimeError(
                        f"Nie udało się połączyć z OpenAI API po {_MAX_RATE_LIMIT_RETRIES} próbach "
                        f"(błąd sieci/DNS): {e}"
                    ) from e

                try:
                    if response.status_code == 429 and attempt < _MAX_RATE_LIMIT_RETRIES - 1:
                        response.read()
                        time.sleep(_seconds_until_retry(response, attempt))
                        continue

                    if response.status_code >= 400:
                        # W trybie stream ciało nie jest jeszcze wczytane -- trzeba je
                        # jawnie odczytać, inaczej raise_for_status()/nasz handler nie
                        # zobaczy treści błędu zwróconej przez OpenAI.
                        response.read()
                        _raise_openai_error(response)

                    for line in response.iter_lines():
                        if not line or not line.startswith("data:"):
                            continue

                        data = line[len("data:"):].strip()

                        if data == "[DONE]":
                            return

                        yield json.loads(data)

                    return
                finally:
                    stream_ctx.__exit__(None, None, None)

            raise RuntimeError("OpenAI API: przekroczono limit prób po wielokrotnych błędach 429 (rate limit)")

        return response_generator()

    def _execute_tool_calls(self, tool_calls: list[dict[str, Any]]) -> list[tuple[str, str]]:
        """
        Executes tool calls requested by the model and appends results to message history.
        Format tool_calls zgodny z OpenAI: [{"id", "type": "function", "function": {"name", "arguments": "<json str>"}}]

        :param tool_calls:
        :return: list of (tool_name, result_text) pairs
        """

        results: list[tuple[str, str]] = []

        for call in tool_calls:
            call_id = call.get("id", "")
            func_name = call["function"]["name"]
            raw_args = call["function"].get("arguments", "{}") or "{}"

            try:
                func_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError as e:
                func_args = {}
                result = f"Error: nie udało się sparsować argumentów narzędzia '{func_name}': {e}"
                self.messages.append({"role": "tool", "tool_call_id": call_id, "content": result})
                results.append((func_name, result))
                continue

            if func_name in self.tool_functions:
                try:
                    result = self.tool_functions[func_name](**func_args)
                except Exception as e:
                    result = f"Error executing {func_name}: {e}"
            else:
                result = f"Error: unknown tool '{func_name}'"

            self.messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "content": str(result),
            })

            results.append((func_name, str(result)))

        return results

    def ask(self, message: str, think: bool = False, max_tool_iterations: int = 8,
            options: dict[str, Any] | None = None) -> str:
        # Dodajemy / Tworzymy message, który wyślemy do modelu
        self._add_user_message(message)

        for _ in range(max_tool_iterations):
            result = self._call_openai(think=think, stream=False, options=options)

            choice = (result.get("choices") or [{}])[0]
            answer_message = choice.get("message", {})

            if answer_message:
                self.messages.append(answer_message)

            tool_calls = answer_message.get("tool_calls")
            if tool_calls:
                self._execute_tool_calls(tool_calls)

                continue

            self._end_assistant_turn()
            content = answer_message.get("content", "") or ""

            return content

        self._end_assistant_turn()
        return "BŁĄD: Osiągnięto limit iteracji wywołań narzędzi"

    def ask_stream(self, message: str, think: bool = False, max_tool_iterations: int = 8,
                   options: dict[str, Any] | None = None) -> Iterator[dict[str, str]]:
        """
        Streams the conversation as a series of typed events (identyczny format jak wcześniej):
          {"type": "thinking", "text": "..."}   - fragment rozumowania modelu (jeśli dostępne)
          {"type": "content", "text": "..."}    - fragment finalnej/pośredniej odpowiedzi tekstowej
          {"type": "tool_call", "name": "...", "arguments": {...}}  - model wywołuje narzędzie
          {"type": "tool_result", "name": "...", "result": "..."}   - wynik wykonania narzędzia
          {"type": "limit"}                     - osiągnięto max_tool_iterations
          {"type": "done", "reason", "prompt_tokens", "eval_tokens"}

        Uwaga: standardowe API Chat Completions OpenAI nie zwraca treści "myślenia" dla
        modeli reasoningowych (o1/o3/gpt-5) -- token reasoningowe są liczone (usage), ale
        ich treść nie jest streamowana. Zdarzenie "thinking" jest tu utrzymane dla
        kompatybilności wstecznej oraz dla serwerów kompatybilnych z OpenAI, które
        dodatkowo zwracają pole 'reasoning_content' w delcie (np. niektóre proxy).

        :param message:
        :param think:
        :param max_tool_iterations:
        :param options:
        :return:
        """

        self._add_user_message(message)

        for _ in range(max_tool_iterations):
            result = self._call_openai(think=think, stream=True, options=options)

            stream_answer = ""
            tool_calls_acc: dict[int, dict[str, Any]] = {}
            finish_reason: str | None = None
            usage: dict[str, Any] = {}

            for chunk in result:
                choices = chunk.get("choices") or []

                if choices:
                    delta = choices[0].get("delta", {})

                    thinking_piece = delta.get("reasoning_content", "") or delta.get("reasoning", "")
                    if thinking_piece:
                        yield {"type": "thinking", "text": thinking_piece}

                    content_piece = delta.get("content", "")
                    if content_piece:
                        stream_answer += content_piece
                        yield {"type": "content", "text": content_piece}

                    for tc_delta in delta.get("tool_calls", []) or []:
                        idx = tc_delta.get("index", 0)
                        acc = tool_calls_acc.setdefault(idx, {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        })

                        if tc_delta.get("id"):
                            acc["id"] = tc_delta["id"]

                        fn_delta = tc_delta.get("function") or {}
                        if fn_delta.get("name"):
                            acc["function"]["name"] += fn_delta["name"]
                        if fn_delta.get("arguments"):
                            acc["function"]["arguments"] += fn_delta["arguments"]

                    if choices[0].get("finish_reason"):
                        finish_reason = choices[0]["finish_reason"]

                if chunk.get("usage"):
                    usage = chunk["usage"]

            tool_calls = [tool_calls_acc[i] for i in sorted(tool_calls_acc)] if tool_calls_acc else None

            answer_message: dict[str, Any] = {
                "role": "assistant",
                "content": stream_answer,
                **({"tool_calls": tool_calls} if tool_calls else {}),
            }
            self.messages.append(answer_message)

            yield {
                "type": "done",
                "reason": finish_reason or "?",
                "prompt_tokens": str(usage.get("prompt_tokens", "?")),
                "eval_tokens": str(usage.get("completion_tokens", "?")),
            }

            if tool_calls:
                for call in tool_calls:
                    func_name = call["function"]["name"]
                    try:
                        func_args = json.loads(call["function"].get("arguments") or "{}")
                    except json.JSONDecodeError:
                        func_args = {}

                    yield {"type": "tool_call", "name": func_name, "arguments": func_args}

                results = self._execute_tool_calls(tool_calls)

                for func_name, result_text in results:
                    yield {"type": "tool_result", "name": func_name, "result": result_text}

                continue

            self._end_assistant_turn()
            return

        self._end_assistant_turn()
        yield {"type": "limit"}

    def pretty(self, message: str, think: bool = True, max_tool_iterations: int = 256):
        for event in self.ask_stream(message, think=think, max_tool_iterations=max_tool_iterations,
                                      options={"temperature": 0.1, "top_p": 0.9, "num_predict": -1}):
            match event["type"]:
                case "thinking":
                    print(f"\033[90m{event['text']}\033[0m", end="", flush=True)
                case "content":
                    print(event["text"], end="", flush=True)
                case "tool_call":
                    print(f"\n🔧 {event['name']}({event['arguments']})", flush=True)
                case "tool_result":
                    print(f"   ↳ {event['result']}\n", flush=True)
                case "limit":
                    print("\n⚠️ Osiągnięto limit iteracji wywołań narzędzi.")
                case "done":
                    print(f"\n\033[90m[done_reason={event['reason']}, "
                          f"prompt={event['prompt_tokens']} tok, out={event['eval_tokens']} tok]\033[0m", flush=True)

    def clear(self) -> None:
        """
        Clears messages except for the initial system prompt
        """

        self.messages = [{"role": "system", "content": self.system}]


class EmbedModel:
    __slots__ = ("model",)

    def __init__(self, model: str) -> None:
        """
        Class that allows for encoding messages

        :param model: encoder model that you want ollama to utilize np. bge-m3
        """

        self.model: str = model

    def encode(self, message: str | list[str], timeout: int = 120) -> list[list[float]]:
        payload: dict[str, Any] = {
            "model": self.model,
            "input": message,
        }

        response = httpx.post(f"http://localhost:11434/api/embed", json=payload, timeout=timeout)

        if response.status_code == 404:
            detail = response.text.strip()
            raise RuntimeError(
                f"Ollama zwróciła 404 dla /api/embed (model='{self.model}'): {detail}\n"
                f"Sprawdź: 1) czy model jest pobrany ('ollama list', 'ollama pull {self.model}'), "
                f"2) czy wersja Ollamy >= 0.3.4 ('ollama --version') -- starsze mają tylko /api/embeddings."
            )

        response.raise_for_status()

        return response.json()["embeddings"]


def langchain_tools_to_openai_format(tools: list[BaseTool]) -> list[dict[str, Any]]:
    """
    Converts LangChain @tool-decorated functions into OpenAI-style tool definitions
    """

    openai_tools: list[dict[str, Any]] = []

    for tool in tools:
        schema = tool.args_schema.model_json_schema() if tool.args_schema else {"type": "object", "properties": {}}

        openai_tools.append({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": {
                    "type": "object",
                    "properties": schema.get("properties", {}),
                    "required": schema.get("required", []),
                },
            },
        })

    return openai_tools


def langchain_tools_to_function_map(tools: list[BaseTool]) -> dict[str, Callable]:
    function_map = {}

    for tool in tools:
        function_map[tool.name] = lambda _tool=tool, **kwargs: _tool.invoke(kwargs)

    return function_map