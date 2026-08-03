import json
import os
from email import generator

import httpx
from typing import Any, Iterator
import fastapi

from dotenv import load_dotenv

load_dotenv()

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")
LLM_MODEL = os.getenv("LLM_MODEL")

EMBED_MODEL = os.getenv("EMBED_MODEL")
EMBED_MODEL_DIM = os.getenv("EMBED_MODEL_DIM")

class ChatModel:
    __slots__ = ("model", "system", "memory", "messages")

    def __init__(self, model: str, system: str = "", memory: bool = True) -> None:
        """
        Class that allows for chatting with a model of your choosing including streaming and memory

        :param model: model that you want ollama to utilize np. qwen3.5:4b
        :param system: system prompt that explains model how to act. Default: "Jesteś pomocnym asystentem."
        :param memory: do model takes previous messages into consideration. Default: True
        """

        self.model: str = model
        self.system: str = system or "Jesteś pomocnym asystentem."
        self.memory: bool = memory

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
                     timeout: int = 120) -> dict[str, Any] | Iterator[dict[str, Any]]:
        if options is None:
            options = {"temperature": 0.1, "top_p": 0.9}

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self.messages,
            "stream": stream,
            "think": think,
            "options": options
        }

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

    def ask(self, message: str, think:bool = False) -> str:
        # Dodajemy / Tworzymy message, który wyślemy do modelu
        self._add_user_message(message)

        result = self._call_ollama(think=think, stream=False)

        answer = result.get("message", {})
        answer = answer.get("content", "")
        self._add_assistant_message(answer)

        return answer

    def ask_stream(self, message: str, think:bool = False) -> Iterator[str]:
        """
        Example usage:

        for piece in chat.ask_stream("Napisz małą rozprawkę o Szekspirze"):
            print(piece, end="", flush=True)

        :param message:
        :param think:
        :return:
        """

        self._add_user_message(message)

        result = self._call_ollama(think=think, stream=False)

        stream_answer = ""
        for chunk in result:
            piece = chunk.get("message", { }).get("content", "")
            stream_answer += piece

            yield piece

            if chunk.get("done"):
                self._add_assistant_message(stream_answer)

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