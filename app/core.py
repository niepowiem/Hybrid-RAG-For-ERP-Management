import json
import os
import httpx
from typing import Any, Iterator, Callable, Iterable

from dotenv import load_dotenv
from langchain.tools import BaseTool

load_dotenv()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
LLM_MODEL = os.getenv("LLM_MODEL")

EMBED_MODEL = os.getenv("EMBED_MODEL")
EMBED_MODEL_DIM = int(os.getenv("EMBED_MODEL_DIM", "1024"))

GRAPH_MODEL= os.getenv("GRAPH_MODEL")
GRAPH_DB_URL = os.getenv("GRAPH_DB_URL", "bolt://localhost:7687")
GRAPH_DB_PASSWORD = os.getenv("GRAPH_DB_PASSWORD")

class ChatModel:
    __slots__ = ("model", "system", "memory", "messages", "tools", "tool_functions")

    def __init__(self, model: str,
                 system: str = "",
                 memory: bool = True,
                 tools: Iterable | None = None) -> None:
        """
        Class that allows for chatting with a model of your choosing including streaming, memory and tool use

        :param model: model that you want ollama to utilize np. qwen3.5:4b
        :param system: system prompt that explains model how to act. Default: "Jesteś pomocnym asystentem."
        :param memory: do model takes previous messages into consideration. Default: True
        :param tool_definitions: list of tool definitions in JSON Schema format (Ollama/OpenAI function-calling format)
        :param tools: mapping of tool name -> callable that executes it
        """

        self.model: str = model
        self.system: str = system or "Jesteś pomocnym asystentem."
        self.memory: bool = memory

        self.tools: list[dict[str, Any]] = langchain_tools_to_ollama_format(tools) if tools else [ ]
        self.tool_functions: dict[str, Callable] = langchain_tools_to_function_map(tools) if tools else { }

        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": self.system},
        ]

    def _add_user_message(self, message: str) -> None:
        """
        Adds user message to messages list for model to know previous conversation

        :param message:
        :return:
        """

        if self.memory:
            self.messages.append({"role": "user", "content": message})

        else:

            # Jeżeli memory jest wyłączone, zostawiamy tylko system prompt i dodajemy wiadomość użytkownika
            self.messages = [
                self.messages[0],
                {"role": "user", "content": message},
            ]

    def _add_assistant_message(self, content: str) -> None:
        """
        Adds model response to history (without thinking)

        :param content:
        :return:
        """

        if self.memory:
            self.messages.append({"role": "assistant", "content": content})

    def _call_ollama(self, think: bool = False, stream: bool = False, options: dict[str, Any] | None = None,
                     timeout: int = 1200) -> dict[str, Any] | Iterator[dict[str, Any]]:
        if options is None:
            options = {"temperature": 0.1, "top_p": 0.9}

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self.messages,
            "stream": stream,
            "think": think,
            "options": options
        }

        if self.tools:
            payload["tools"] = self.tools

        if not stream:
            response = httpx.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=timeout)
            response.raise_for_status()

            return response.json()

        def response_generator() -> Iterator[dict[str, Any]]:
            with httpx.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload, timeout=timeout) as response:
                response.raise_for_status()

                for line in response.iter_lines():
                    if not line:
                        continue

                    yield json.loads(line)

        return response_generator()

    def _execute_tool_calls(self, tool_calls: list[dict[str, Any]]) -> list[tuple[str, str]]:
        """
        Executes tool calls requested by the model and appends results to message history

        :param tool_calls:
        :return: list of (tool_name, result_text) pairs
        """

        results: list[tuple[str, str]] = []

        for call in tool_calls:
            func_name = call["function"]["name"]
            func_args = call["function"].get("arguments", {})

            if func_name in self.tool_functions:
                try:
                    result = self.tool_functions[func_name](**func_args)
                except Exception as e:
                    result = f"Error executing {func_name}: {e}"
            else:
                result = f"Error: unknown tool '{func_name}'"

            self.messages.append({
                "role": "tool",
                "content": str(result)
            })

            results.append((func_name, str(result)))

        return results

    def ask(self, message: str, think: bool = False, max_tool_iterations: int = 8, options: dict[str, Any] | None = None) -> str:
        # Dodajemy / Tworzymy message, który wyślemy do modelu
        self._add_user_message(message)

        for _ in range(max_tool_iterations):
            result = self._call_ollama(think=think, stream=False, options=options)

            answer_message = result.get("message", {})
            self.messages.append(answer_message)

            tool_calls = answer_message.get("tool_calls")
            if tool_calls:
                self._execute_tool_calls(tool_calls)
                continue

            content = answer_message.get("content", "")
            if not self.memory:
                # przywracamy zachowanie _add_assistant_message dla memory=False
                self.messages = [self.messages[0], self.messages[-len(tool_calls or []) - 2]] if False else self.messages
            return content

        return "Osiągnięto limit iteracji wywołań narzędzi."

    def ask_stream(self, message: str, think: bool = False, max_tool_iterations: int = 8,
                   options: dict[str, Any] | None = None) -> Iterator[dict[str, str]]:
        """
        Streams the conversation as a series of typed events:
          {"type": "thinking", "text": "..."}   - fragment rozumowania modelu
          {"type": "content", "text": "..."}    - fragment finalnej/pośredniej odpowiedzi tekstowej
          {"type": "tool_call", "name": "...", "arguments": {...}}  - model wywołuje narzędzie
          {"type": "tool_result", "name": "...", "result": "..."}   - wynik wykonania narzędzia
          {"type": "limit"}                     - osiągnięto max_tool_iterations

        Example usage:

        for event in chat.ask_stream("Dodaj Floriana...", think=True):
            if event["type"] == "thinking":
                print(f"\033[90m{event['text']}\033[0m", end="", flush=True)
            elif event["type"] == "content":
                print(event["text"], end="", flush=True)
            elif event["type"] == "tool_call":
                print(f"\n🔧 {event['name']}({event['arguments']})", flush=True)
            elif event["type"] == "tool_result":
                print(f"   ↳ {event['result']}", flush=True)

        :param message:
        :param think:
        :param max_tool_iterations:
        :param options:
        :return:
        """

        self._add_user_message(message)

        for _ in range(max_tool_iterations):
            result = self._call_ollama(think=think, stream=True, options=options)

            stream_thinking, stream_answer = "", ""
            tool_calls: list[dict[str, Any]] | None = None
            answer_message: dict[str, Any] = {}

            for chunk in result:
                msg = chunk.get("message", {})

                thinking_piece = msg.get("thinking", "")
                if thinking_piece:
                    stream_thinking += thinking_piece
                    yield {"type": "thinking", "text": thinking_piece}

                content_piece = msg.get("content", "")
                if content_piece:
                    stream_answer += content_piece
                    yield {"type": "content", "text": content_piece}

                if msg.get("tool_calls"):
                    tool_calls = msg["tool_calls"]

                if chunk.get("done"):
                    answer_message = {
                        "role": "assistant",
                        "content": stream_answer,
                        **({"tool_calls": tool_calls} if tool_calls else {})
                    }

            self.messages.append(answer_message)

            if tool_calls:
                for call in tool_calls:
                    func_name = call["function"]["name"]
                    func_args = call["function"].get("arguments", {})

                    yield {"type": "tool_call", "name": func_name, "arguments": func_args}

                results = self._execute_tool_calls(tool_calls)

                for func_name, result_text in results:
                    yield {"type": "tool_result", "name": func_name, "result": result_text}

                continue

            self._add_assistant_message(stream_answer)

            return

        yield {"type": "limit"}

    def pretty(self, message: str, think: bool = True, max_tool_iterations: int = 256):
        for event in self.ask_stream(message, think=think, max_tool_iterations=max_tool_iterations, options={"temperature": 0.1, "top_p": 0.9, "num_predict": -1}):
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

    def clear(self) -> None:
        """
        Clears messages except for the initial system prompt

        :return:
        """

        self.messages = [{"role": "system", "content": self.system}]

class EmbedModel:
    __slots__ = ("model", "dim")

    def __init__(self, model: str, dim: int) -> None:
        """
        Class that allows for encoding messages

        :param model: encoder model that you want ollama to utilize np. bge-m3
        """

        self.model: str = model
        self.dim: int = dim

    def encode(self, message: str | list[str], timeout: int= 120) -> list[list[float]]:
        payload: dict[str, Any] = {
            "model": self.model,
            "input": message,
        }

        response = httpx.post(f"{OLLAMA_URL}/api/embed", json=payload, timeout=timeout)
        response.raise_for_status()

        return response.json()["embeddings"]

def langchain_tools_to_ollama_format(tools: list[BaseTool]) -> list[dict[str, Any]]:
    """
    Converts LangChain @tool-decorated functions into Ollama/OpenAI-style tool definitions
    """

    ollama_tools: list[dict[str, Any]] = []

    for tool in tools:
        schema = tool.args_schema.model_json_schema() if tool.args_schema else {"type": "object", "properties": {}}

        ollama_tools.append({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": {
                    "type": "object",
                    "properties": schema.get("properties", {}),
                    "required": schema.get("required", [])
                }
            }
        })

    return ollama_tools

def langchain_tools_to_function_map(tools: list[BaseTool]) -> dict[str, Callable]:
    function_map = { }

    for tool in tools:
        function_map[tool.name] = lambda _tool=tool, **kwargs: _tool.invoke(kwargs)

    return function_map

