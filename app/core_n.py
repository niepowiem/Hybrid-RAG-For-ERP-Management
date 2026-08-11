from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
from typing import Any, Iterable, Callable, Iterable, Iterator
from abc import ABC, abstractmethod

from dotenv import load_dotenv
from langchain.tools import BaseTool

def _require_env(name:str) -> str:
    """
    Funkcja wspomagająca ładowanie zmiennych z .env.
    Brak wartości przerywa import z czytelnym komunikatem,
    zamiast pozostawiać wartość null, która cicho powoduje błędy

    :param name: Nazwa zmiennej w .env
    :return: Wartość zmiennej w .env
    """

    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Brak zmiennej '{name}' w środowisku. Uzupełnij plik .env!")

    return value

# Ładujemy plik .env
load_dotenv()

OPENWEBUI_KEY = os.getenv("OPENWEBUI_KEY")

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

OPENAI_KEY = os.getenv("OPENAI_KEY")
OPENWEBUI_URL = os.getenv("OPENWEBUI_URL")

AGENT_MODEL = _require_env(name="LLM_MODEL")
GRAPH_BUILDER_MODEL = _require_env(name="GRAPH_BUILDER_MODEL")
EMBEDDING_MODEL = _require_env(name="EMBEDDING_MODEL")
EMBEDDING_DIM = int(_require_env(name="EMBEDDING_DIM"))

PROJECT_ROOT = Path(__file__).resolve().parent.parent

@dataclass(frozen=True, slots=True)
class GenerationOptions:
    """
    Uniwersalne opcje generowania, niezależne od providera. Każdy provider
    tłumaczy je sam na swoje pola.

    Każdy z providerów chce inne nazwy
    """

    temperature: float = 0.1
    top_p: float = 0.9
    max_response_tokens: int | None = None
    context_length: int | None = None

@dataclass(frozen=True, slots=True)
class ToolCall:
    """
    Znormalizowane wywołanie narzędzia.
    Wspólny format dla wszystkich API
    """

    id: str
    name: str
    arguments: str

    # Zwraca ({Argumenty}, "") przy sukcesie lub (None, opis błędu)
    def parse(self) -> tuple[dict[str, Any] | None, str]:
        try:
            return json.loads(self.arguments or "{}"), ""

        except json.JSONDecodeError as e:
            return None, str(e)

class _LLMProviderAPI(ABC):
    __slots__ = ("model", "system", "memory", "history", "how_to_use_tools", "tools", "client", "client_owner")

    TIMEOUT: int = 1200
    MAX_RETRIES: int = 6
    DEFAULT_OPTIONS: GenerationOptions = GenerationOptions()

    def __init__(self, model: str,
                 system: str,
                 memory: bool,
                 tools: Iterable[BaseTool] | None,
                 client: httpx.Client | None = None) -> None:
        # Sprawdzamy, czy wszystkie zmienne zostały wczytane
        self._check_required()

        self.model:str = model
        self.system:str = system
        self.memory:bool = memory

        # Tworzymy narzędzia
        self._make_tools(tools=list(tools) if tools else [])

        # Dajemy tylko system message
        self.history: list[dict[str, Any]] = self._fresh_history()

        self.client_owner: bool = client is None
        self.client: httpx.Client = client or httpx.Client(
            #  Rozdzielamy time-outy. Martwy serwer ma paść po 10s, a nie po 20 minutach,
            #  ale samo generowanie odpowiedzi może trwać długo.
            timeout=httpx.Timeout(connect=10.0, read=self.TIMEOUT, write=60.0, pool=10.0)
        )

    @staticmethod
    @abstractmethod
    def _check_required():
        """Sprawdzamy, czy niczego nie brakuje i nie wywali błąd"""

    @property
    @abstractmethod
    def _endpoint(self) -> str:
        """URL end-pointu chatu"""

    @abstractmethod
    def _build_payload(self, think: bool, options: GenerationOptions) -> dict[str, Any]:
        """Ciało request'u, zawsze w trybie strumieniowym"""

    @abstractmethod
    def _stream_turn(self, think: bool, options: GenerationOptions) -> Iterator[dict[str, str]]:
        """
        Generator jednej tury: emituje zdarzenia thinking/content/done, dopisuje
        odpowiedź asystenta do self.history i przez `return` oddaje listę
        ToolCall (odbieraną w pętli przez `yield from`).
        """

    @abstractmethod
    def _append_tool_result(self, call: ToolCall, result: str) -> None:
        """Dopisuje wynik narzędzia do historii w formacie danego API."""

    @staticmethod
    def _headers() -> dict[str, str]:
        return {"Content-Type": "application/json"}

    def _fresh_history(self) -> list[dict[str, Any]]:
        return [{"role": "system", "content": self.system}]

    def _build_how_to_use_tools(self, tools: list[BaseTool]) -> list[dict[str, Any]]:
        """
        Opis narzędzi dla modelu

        :param tools:
        :return:
        """

        how_to_use: list[dict[str, Any]] = []

        for tool in tools:
            schema = tool.args_schema.model_json_schema() if tool.args_schema else {}
            how_to_use.append({
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

        return how_to_use

    @staticmethod
    def _build_tools(tools: list[BaseTool]) -> dict[str, Callable]:
        """
        Tworzy mapę narzędzi do wywołania dla _LLMProviderAPI

        :param tools:
        :return:
        """

        return {tool.name: (lambda _tool=tool, **kwargs: _tool.invoke(kwargs)) for tool in tools}

    def _make_tools(self, tools: list[BaseTool]):
        self.how_to_use_tools: list[dict[str, Any]] = self._build_how_to_use_tools(tools)
        self.tools: dict[str, Callable] = self._build_tools(tools)

    def _raise_api_error(self, response: httpx.Response) -> None:
        """
        Błąd API to zwykle JSON {"error": {"message", "type", "code"}}.
        raise_for_status() pokazuje samo '400 Bad Request', a prawdziwy powód jest w treści.
        Ta funkcja wyciąga ją z json

        :param response:
        :return:
        """

        try:
            body = response.json()
            error_details = body.get("error")

            if isinstance(error_details, dict):
                error_details = error_details.get("message")

            error_details = error_details or json.dumps(body, ensure_ascii=False)

        except Exception:
            error_details = response.text

        raise RuntimeError(
            f"{type(self).__name__} zwróciło błąd {response.status_code} "
            f"dla modelu '{self.model}':\n{error_details}"
        )

    def _check_err_400s(self, response: httpx.Response, read:bool=False) -> bool:
        if response.status_code >= 400:
            if read:
                response.read()

            self._raise_api_error(response)

        return True

    @staticmethod
    def _retry_delay(attempt: int, response: httpx.Response | None = None) -> float:
        """
        Ile czekać przed ponowieniem. Najpierw nagłówek 'Retry-After', potem
        komunikat OpenAI ("Please try again in 4.944s"), na końcu backoff.

        :param attempt: Ile razy już próbowaliśmy
        :param response:
        :return:
        """

        if response is not None:
            if header := response.headers.get("retry-after"):
                try:
                    return float(header) + 0.25

                except ValueError:
                    pass

            match = re.search(r"try again in ([\d.]+)s", response.text)
            if match:
                return float(match.group(1)) + 0.25

        # Jeżeli wszystko zawiedzie
        return min(2 ** attempt, 30.0)

    def _stream_lines(self, url: str, payload: dict[str, Any]) -> Iterator[str]:
        """
        POST + strumień linii, z ponowieniami przy 429 i błędach transportu.

        Ponawiamy TYLKO dopóki nic nie zostało jeszcze wyemitowane. Zerwanie
        połączenia w połowie odpowiedzi i restart od zera oznaczałby, że
        użytkownik zobaczy początek odpowiedzi dwa razy, a do historii trafi
        sklejka dwóch prób.
        """

        line_emitted = False

        for attempt in range(self.MAX_RETRIES):
            try:
                with self.client.stream("POST", url, headers=self._headers(), json=payload) as response:
                    if response.status_code == 429 and attempt < self.MAX_RETRIES - 1 and not line_emitted:
                        response.read()
                        time.sleep(self._retry_delay(attempt, response))
                        continue

                    # W trybie strumieniowym ciało nie jest jeszcze wczytane
                    # i bez read() nie zobaczymy błędu
                    self._check_err_400s(response, read=True)

                    for line in response.iter_lines():
                        line_emitted = True
                        yield line

                    return

            except httpx.TransportError as e:
                if line_emitted:
                    raise RuntimeError(f"Zerwane połączenie w trakcie odpowiedzi: {e}") from e

                if attempt < self.MAX_RETRIES - 1:
                    time.sleep(self._retry_delay(attempt))
                    continue

                raise RuntimeError(
                    f"Brak połączenia z {url} po {self.MAX_RETRIES} próbach: {e}"
                ) from e

        raise RuntimeError(f"{url}: przekroczono limit prób po wielokrotnych błędach 429")

    def _get_json(self, url: str) -> dict[str, Any]:
        response = self.client.get(url, headers=self._headers())

        self._check_err_400s(response)
        return response.json()

    @staticmethod
    def _sse(lines: Iterable[str]) -> Iterator[dict[str, Any]]:
        """
        Server-Sent Events: linie 'data: {...}', koniec sygnalizowany '[DONE]'

        :param lines: Linie z _stream_lines
        :return:
        """

        for line in lines:
            if not line or not line.startswith("data:"):
                continue

            data = line[len("data:"):].strip()

            if not data:
                continue

            if data == "[DONE]":
                return

            yield json.loads(data)

    @staticmethod
    def _ndjson(lines: Iterable[str]) -> Iterator[dict[str, Any]]:
        """
        Natywna Ollama: jeden obiekt JSON na linię, bez prefiksów

        :param lines: lines: Linie z _stream_lines
        :return:
        """

        for line in lines:
            line = line.strip()

            if line:
                yield json.loads(line)

    def _add_user_message(self, message: str) -> None:
        if self.memory:
            self.history.append({"role": "user", "content": message})
        else:
            self.history = [*self._fresh_history(), {"role": "user", "content": message}]

    def _end_turn(self) -> None:
        """
        Przy memory=False czyścimy wszystko poza system promptem.
        Odpowiedzi asystenta i wyniki narzędzi są potrzebne tylko w obrębie jednej tury

        :return:
        """

        if not self.memory:
            self.history = self._fresh_history()

    def _run_tools(self, calls: list[ToolCall]) -> list[tuple[str, str]]:
        """
        Wykonuje narzędzia i dopisuje wyniki do historii.
        BŁĄD:' oznacza awarię, a 'OK:' lub 'INFO:' sukcess

        :param calls:
        :return:
        """

        results: list[tuple[str, str]] = []

        for call in calls:
            arguments, parse_error = call.parse()

            if arguments is None:
                result = f"BŁĄD: nie udało się sparsować argumentów narzędzia '{call.name}': {parse_error}"

            elif call.name not in self.tools:
                known = ", ".join(sorted(self.tools)) or "brak"
                result = f"BŁĄD: nieznane narzędzie '{call.name}'. Dostępne: {known}"

            else:
                try:
                    result = str(self.tools[call.name](**arguments))

                except Exception as e:
                    result = f"BŁĄD: narzędzie '{call.name}' rzuciło wyjątek: {type(e).__name__}: {e}"

            self._append_tool_result(call, result)
            results.append((call.name, result))

        return results

    def call(self, message: str,
             think: bool = False,
             max_tool_iterations: int = 8,
             generation_options: GenerationOptions | None = None) -> Iterator[dict[str, Any]]:
        self._add_user_message(message)
        options: GenerationOptions = generation_options or self.DEFAULT_OPTIONS

        for _ in range(max_tool_iterations):
            calls: list[ToolCall] = yield from self._stream_turn(think=think, options=options)

            if not calls:
                self._end_turn()
                return

            for call in calls:
                arguments, _ = call.parse()
                yield {"type": "tool_call", "name": call.name, "arguments": arguments or { }}

            for name, result in self._run_tools(calls):
                yield {"type": "tool_result", "name": name, "result": result}

        self._end_turn()
        yield { "type": "limit" }

    def ask(self, message: str,
            think: bool = False,
            max_tool_iterations: int = 8,
            options: GenerationOptions | None = None) -> str:
        """
        Odpowiedź jako jeden string. Zbudowana na ask_stream, żeby pętla
        tool-callingu istniała w JEDNYM miejscu
        Wcześniej dwie kopie tej samej logiki rozjeżdżały się przy każdej poprawce.

        :param message:
        :param think:
        :param max_tool_iterations:
        :param options:
        :return:
        """

        parts: list[str] = []

        for event in self.call(message, think, max_tool_iterations, options):
            match event["type"]:
                case "content":
                    parts.append(event["text"])

                case "tool_call":

                    # Tekst sprzed wywołania narzędzia to komentarz modelu w trakcie
                    # pracy, nie odpowiedź. Interesuje nas tylko ostatnia tura.
                    parts.clear()

                case "limit":
                    return "BŁĄD: Osiągnięto limit iteracji wywołań narzędzi"

        return "".join(parts)

    def clear_history(self) -> None:
        self.history = self._fresh_history()

    def close_client(self) -> None:
        if self.client_owner:
            self.client.close()

class _OpenAIAPINonReasoning(_LLMProviderAPI):
    __slots__ = ()

    # URL end-pointu dla openai
    BASE_URL: str = "https://api.openai.com/v1"

    @staticmethod
    def _check_required() -> None:
        if not OPENAI_KEY:
            raise ValueError("Nie podano OPENAI_KEY w pliku .env!")

    @staticmethod
    def _headers() -> dict[str, str]:
        return {"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"}

    @property
    def _endpoint(self) -> str:
        return f"{self.BASE_URL}/chat/completions"

    @staticmethod
    def _provider_generation_options(options: GenerationOptions) -> dict[str, Any]:
        payload: dict[str, Any] = {"temperature": options.temperature, "top_p": options.top_p}

        if options.max_response_tokens:
            payload["max_tokens"] = options.max_response_tokens

        # OpenAI nie przyjmuje długości kontekstu, więc pomijamy
        return payload

    def _build_payload(self, think: bool, options: GenerationOptions) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self.history,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        if self.how_to_use_tools:
            payload["tools"] = self.how_to_use_tools

        payload |= self._provider_generation_options(options)

        return payload

    def _append_tool_result(self, call: ToolCall, result: str) -> None:
        self.history.append({"role": "tool", "tool_call_id": call.id, "content": result})

    def _stream_turn(self, think: bool, options: GenerationOptions) -> Iterator[dict[str, str]]:
        chunks = self._sse(self._stream_lines(self._endpoint, self._build_payload(think, options)))

        answer:str = ""
        finish_reason = ""

        # Akumulator z int, ponieważ tool_calls przychodzą pofragmentowane i identyfikowane po 'index', nie po id
        tools_accumulator: dict[int, dict[str, Any]] = {}
        usage: dict[str, Any] = {}


        # Każdy chunk to słownik wyglądający np.:
        # {
        #   "choices": [{"delta": {"content": "Cześć", "tool_calls": [...]}, "finish_reason": null}],
        #   "usage": null
        # }
        for chunk in chunks:
            if chunk.get("usage"):
                usage = chunk["usage"]

            choices = chunk.get("choices") or []
            if not choices:
                continue

            # Aktualny fragment odpowiedzi
            # Tutaj przychodzą nowe kawałki treści, myśli lub wywołań narzędzi
            delta = choices[0].get("delta") or { }

            # Niektóre proxy (np. Open WebUI) dodają reasoning_content.
            # Jeśli jest, zwracamy event typu "thinking".
            # (Standardowe OpenAI nie streamuje treści rozumowania, więc jest to rozszerzenie).
            thinking = delta.get("reasoning_content") or delta.get("reasoning") or ""
            if thinking:
                yield {"type": "thinking", "text": thinking}

            # Kawałek tekstu dopisywany jest do całości (answer)
            # i natychmiast oddawany (yield) jako event do użytkownika.
            content = delta.get("content") or ""
            if content:
                answer += content
                yield {"type": "content", "text": content}

            # Próbuje pobrać listę fragmentów wywołań narzędzi z bieżącej delty
            # Jeśli delta zawiera fragmenty narzędzi, przetwórz każdy z nich
            for piece in delta.get("tool_calls") or []:
                slot = tools_accumulator.setdefault(piece.get("index", 0), {"id": "", "name": "", "arguments": ""})

                if piece.get("id"):
                    slot["id"] = piece["id"]

                function = piece.get("function") or { }
                slot["name"] += function.get("name") or ""
                slot["arguments"] += function.get("arguments") or ""

            if choices[0].get("finish_reason"):
                finish_reason = choices[0]["finish_reason"]

        # Z posortowanych po indeksie slotów tworzymy listę obiektów ToolCall (namedtuple lub prosta klasa)
        # Każdy zawiera już skompletowane id, name i surowe argumenty
        calls = [ToolCall(slot["id"], slot["name"], slot["arguments"]) for _, slot in sorted(tools_accumulator.items())]

        # Tworzymy obiekt roli assistant z całą odpowiedzią tekstową i ewentualnymi wywołaniami narzędzi
        # w formacie zgodnym z API OpenAI. To jest potrzebne do kontekstu kolejnych tur
        message: dict[str, Any] = {"role": "assistant", "content": answer}
        if calls:
            message["tool_calls"] = [
                {"id": c.id, "type": "function", "function": {"name": c.name, "arguments": c.arguments}}
                for c in calls
            ]

        self.history.append(message)

        # Informujemy użytkownika o zakończeniu strumienia,
        # podając powód, liczbę tokenów wejściowych i wyjściowych
        yield {
            "type": "done",
            "reason": finish_reason or "?",
            "prompt_tokens": str(usage.get("prompt_tokens", "?")),
            "eval_tokens": str(usage.get("completion_tokens", "?")),
        }

        return calls

    def check(self) -> str:
        models = self._get_json(f"{self.BASE_URL}/models")
        names = {m.get("id") for m in models.get("data", [])}

        return f"OK: OpenAI odpowiada, model '{self.model}' " + ("widoczny" if self.model in names else "Niewidoczny")

class _OPENAIAPIReasoning(_OpenAIAPINonReasoning):
    __slots__ = ()

    @property
    def _endpoint(self) -> str:
        return f"{self.BASE_URL}/responses"

    # System prompt idzie osobnym polem 'instructions', nie jako element wejścia.
    def _fresh_history(self) -> list[dict[str, Any]]:
        return []

    def _build_how_to_use_tools(self, tools: list[BaseTool]) -> list[dict[str, Any]]:
        # Responses chce formatu PŁASKIEGO (name/description/parameters na wierzchu),
        # w odróżnieniu od zagnieżdżonego {"function": {...}} w Chat Completions.
        return [
            {
                "type": "function",
                "name": htu["function"]["name"],
                "description": htu["function"]["description"],
                "parameters": htu["function"]["parameters"],
            }
            for htu in super()._build_how_to_use_tools(tools)
        ]

    def _build_payload(self, think: bool, options: GenerationOptions) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "input": self.history,
            "instructions": self.system,
            "stream": True,

            # Historię trzymamy u siebie, nie polegamy na stanie po stronie OpenAI.
            "store": False,
        }

        if self.how_to_use_tools:
            payload["tools"] = self.how_to_use_tools

        if think:
            # 'summary: auto' daje podgląd rozumowania w streamie
            # encrypted_content pozwala modelowi kontynuować rozumowanie w kolejnej iteracji pętli
            # narzędzi mimo store=False.
            # Bez tego jakość wielokrokowego tool-callingu spada
            payload["reasoning"] = {"effort": "medium", "summary": "auto"}
            payload["include"] = ["reasoning.encrypted_content"]

        # temperature/top_p są tu ignorowane, ponieważ modele reasoning-owe ich nie przyjmują
        if options.max_response_tokens:
            payload["max_output_tokens"] = options.max_response_tokens

        return payload

    def _append_tool_result(self, call: ToolCall, result: str) -> None:
        self.history.append({"type": "function_call_output", "call_id": call.id, "output": result})

    def _end_turn(self) -> None:
        # Jeżeli nie mamy historii to czyścimy pamięć
        if not self.memory:
            self.history = self._fresh_history()
            return

        # Elementy reasoning/function_call/function_call_output są potrzebne tylko
        # w obrębie jednej pętli narzędzi. Między pytaniami zostawiamy same
        # wiadomości, żeby kontekst nie puchł zaszyfrowanym rozumowaniem
        self.history = [item for item in self.history if item.get("type") in (None, "message")]

    def _stream_turn(self, think: bool, options: GenerationOptions) -> Iterator[dict[str, str]]:
        chunks = self._sse(self._stream_lines(self._endpoint, self._build_payload(think, options)))
        final: dict[str, Any] | None = None

        # Iterujemy po wszystkich chunkach i dopasowujemy typ zdarzenia do akcji
        # Myślenie i treść lecą na żywo (przez yield), użytkownik dostaje je natychmiast
        for chunk in chunks:
            match chunk.get("type"):
                case "response.reasoning_summary_text.delta" | "response.reasoning_text.delta":
                    if chunk.get("delta"):
                        yield {"type": "thinking", "text": chunk["delta"]}

                case "response.output_text.delta":
                    if chunk.get("delta"):
                        yield {"type": "content", "text": chunk["delta"]}

                case "response.completed" | "response.incomplete" | "response.failed":
                    final = chunk.get("response")

                case "error":
                    raise RuntimeError(f"Responses API zwróciło błąd strumienia: {chunk}")

        if final is None:
            # Brak 'response.completed' oznacza ucięty strumień. Cicho przyjęta
            # pusta tura byłaby gorsza: pętla poleciałaby dalej z niepełną historią
            raise RuntimeError("Responses API: strumień skończył się bez zdarzenia 'response.completed'")

        # Elementy wyjściowe (w tym reasoning) wracają do historii W CAŁOŚCI
        # pominięcie reasoning przy function callingu psuje ciągłość rozumowania
        output = final.get("output") or []
        self.history.extend(output)

        usage = final.get("usage") or {}

        yield {
            "type": "done",
            "reason": final.get("status", "?"),
            "prompt_tokens": str(usage.get("input_tokens", "?")),
            "eval_tokens": str(usage.get("output_tokens", "?")),
        }

        return [
            ToolCall(item.get("call_id", ""), item.get("name", ""), item.get("arguments", "{}"))
            for item in output if item.get("type") == "function_call"
        ]

class _OllamaAPI(_LLMProviderAPI):
    __slots__ = ()

    # URL end-pointu dla ollamy
    BASE_URL = OLLAMA_URL

    def _check_required(self) -> None:
        if not self.BASE_URL:
            raise ValueError("Brak URL-a serwera Ollamy (OLLAMA_URL w .env).")

    @property
    def _endpoint(self) -> str:
        return f"{self.BASE_URL}/api/chat"

    def _build_payload(self, think: bool, options: GenerationOptions) -> dict[str, Any]:
        ollama_options: dict[str, Any] = {"temperature": options.temperature, "top_p": options.top_p}

        if options.max_response_tokens is not None:
            ollama_options["num_predict"] = options.max_response_tokens

        if options.context_length is not None:
            ollama_options["num_ctx"] = options.context_length

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self.history,
            "stream": True,
            "options": ollama_options,

            # UWAGA: think=True potrafiło dawać puste tury (done_reason=stop, zero, tool_calls).
            # Ingest grafu chodzi z think=False. Nie zmieniaj bez pomiaru.
            "think": think,
        }

        if self.how_to_use_tools:
            payload["tools"] = self.how_to_use_tools

        return payload

    def _append_tool_result(self, call: ToolCall, result: str) -> None:
        # Ollama nie używa tool_call_id; parowanie jest po kolejności, a 'tool_name'
        # pomaga modelowi rozróżnić wyniki, gdy w jednej turze wywołał kilka narzędzi.
        self.history.append({"role": "tool", "tool_name": call.name, "content": result})

    def _stream_turn(self, think: bool, options: GenerationOptions) -> Iterator[dict[str, str]]:
        chunks = self._ndjson(self._stream_lines(self._endpoint, self._build_payload(think, options)))

        answer: str = ""
        done_reason: str = ""
        prompt_tokens: str = "?"
        eval_tokens: str = "?"

        # Lista surowych wywołań narzędzi (Ollama wysyła je w całości, nie strumieniowo
        raw_calls: list[dict[str, Any]] = []

        # Każdy chunk to słownik z kluczami: message (delta) i opcjonalnie done (znacznik końca) np.
        # {
        #   "message": {"content": "Cześć"},
        #   "done": false
        # }
        for chunk in chunks:
            message = chunk.get("message") or {}

            if message.get("thinking"):
                yield {"type": "thinking", "text": message["thinking"]}

            if message.get("content"):
                answer += message["content"]
                yield {"type": "content", "text": message["content"]}

            # Ollama wysyła tool_calls w całości, nie w deltach, czyli bez akumulatora
            raw_calls.extend(message.get("tool_calls") or [])

            # Ostatni chunk ma "done": true i zawiera powód zakończenia oraz statystyki tokenów
            if chunk.get("done"):
                done_reason = chunk.get("done_reason", "")
                prompt_tokens = str(chunk.get("prompt_eval_count", "?"))
                eval_tokens = str(chunk.get("eval_count", "?"))

        # Normalizacja wywołań narzędzi
        calls: list[ToolCall] = []
        for index, raw in enumerate(raw_calls):
            function = raw.get("function") or {}
            arguments = function.get("arguments", {})
            calls.append(ToolCall(
                id=raw.get("id") or f"call_{index}",
                name=function.get("name", ""),

                # Ollama daje argumenty jako obiekt, OpenAI jako string
                # Normalizujemy do stringa, żeby ToolCall znaczyło wszędzie to samo.
                arguments=arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False),
            ))

        # Buduje wiadomość asystenta i zapisuje ją wraz
        # z surowymi wywołaniami (w formacie Ollamy) do historii konwersacji.
        message = {"role": "assistant", "content": answer}
        if raw_calls:
            message["tool_calls"] = raw_calls

        self.history.append(message)

        # Emituje "done" ze statystykami, a potem zwraca listę ToolCall dla użytkownika.
        yield {
            "type": "done",
            "reason": done_reason or "?",
            "prompt_tokens": prompt_tokens,
            "eval_tokens": eval_tokens,
        }

        return calls

    def check(self) -> str:
        tags = self._get_json(f"{self.BASE_URL}/api/tags")
        names = {m.get("name") for m in tags.get("models", [])}

        if self.model not in names:
            return f"BŁĄD: serwer odpowiada, ale nie ma modelu '{self.model}'. Dostępne: {sorted(names)}"

        return f"OK: '{self.model}' dostępny"

class _OpenWebUIAPI(_OllamaAPI):
    __slots__ = ()
    BASE_URL = f"{OPENWEBUI_URL.rstrip('/')}/ollama" if OPENWEBUI_URL else ""

    def _check_required(self) -> None:
        if not OPENWEBUI_URL:
            raise ValueError("Brak OPENWEBUI_URL w .env! (np. http://dgx-spark:3000)")

        if not OPENWEBUI_KEY:
            raise ValueError("Brak OPENWEBUI_KEY w .env! Klucz z Settings > Account w Open WebUI.")

    @staticmethod
    def _headers() -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENWEBUI_KEY}"
        }

class ChatModel:
    __slots__ = ("api",)
    REASONING_PREFIXES = ("o1", "o3", "o4", "gpt-5")

    PROVIDERS: dict[str, type[_LLMProviderAPI]] = {
        "openai": _OpenAIAPINonReasoning,
        "openai-responses": _OPENAIAPIReasoning,
        "ollama": _OllamaAPI,
        "openwebui": _OpenWebUIAPI,
    }

    def __init__(self, model: str,
                system: str = "Jesteś pomocnym asystentem!",
                memory: bool = True,
                tools: Iterable[BaseTool] | None = None,
                provider: str | None = None,
                client: httpx.Client | None=None) -> None:
        """

        :param model:
        :param system:
        :param memory:
        :param tools:
        :param provider:
        :param client:
        :return:
        """

        selected_provider = provider or self._identify_source(model)
        if selected_provider not in self.PROVIDERS:
            raise ValueError(f"Nieznany provider '{selected_provider}'\nDostępne: {sorted(self.PROVIDERS)}")

        self.api = self.PROVIDERS[selected_provider](model=model,
                                                     system=system,
                                                     memory=memory,
                                                     tools=tools,
                                                     client=client)

    def _identify_source(self, model: str) -> str:

        lowered = model.lower()

        if lowered.startswith(self.REASONING_PREFIXES):
            return "openai-responses"

        if lowered.startswith(("gpt-", "chatgpt")):
            return "openai"

        if ":" in model:  # konwencja tagów Ollamy, np. "qwen3.5:9b"
            return "ollama"

        raise ValueError(
            f"Nie umiem rozpoznać providera dla modelu '{model}'. "
            f"Podaj jawnie: ChatModel(..., provider='ollama'|'spark'|'openai'|'openai-responses')."
        )

    @property
    def messages(self) -> list[dict[str, Any]]:
        return self.api.history

    def ask(self, message: str, think: bool = False, max_tool_iterations: int = 8,
            options: GenerationOptions | None = None) -> Iterator[dict[str, str]]:
        return self.api.call(message, think, max_tool_iterations, options)

    def check(self) -> str:
        checker = getattr(self.api, "check", None)

        if checker is None:
            return f"INFO: provider {type(self.api).__name__} nie udostępnia health-checku"

        return checker()

    def clear(self) -> None:
        self.api.clear_history()

    def close(self) -> None:
        self.api.close_client()

    def pretty(self, message: str, think: bool = True, max_tool_iterations: int = 256,
               options: GenerationOptions | None = None) -> None:
        for event in self.ask(message, think, max_tool_iterations, options):
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