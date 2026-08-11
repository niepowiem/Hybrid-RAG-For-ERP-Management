> # core.py
> Ten plik zawiera główną obsługę i funkcjonalność związaną z wywoływaniem, testowaniem oraz diagnozowaniem
działania LLMów.

> ### _require_env (name: str) -> str
>Funkcja pomocnicza, wspomagająca ładowanie zmiennych z .env.
Brak wartości przerywa import z czytelnym komunikatem,
zamiast pozostawiać wartość null, która cicho powoduje błędy
>
>> `LLM_MODEL = _require_env("LLM_MODEL_ENV_VAR")`

> ### GenerationOptions
> tbc

> ### ToolCall
> tbc

> ### _LLMProviderAPI
> tbc

> ### _OpenAIAPINonReasoning
> tbc

> ### _OPENAIAPIReasoning
> tbc

> ### _OllamaAPI
> tbc

> ### _OpenWebUIAPI
> tbc

> ### ChatModel
> tbc