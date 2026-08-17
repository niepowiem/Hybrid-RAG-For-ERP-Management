from app.core import EmbeddingModel, ChatModel

def embed(embed_model: EmbeddingModel):
    r = embed_model.embed("TEST")
    print(f'model: {r.model}\nlen(e): {len(r.embeddings)}\nlen(e[0]): {len(r.embeddings[0])}\ne[0]: {r.embeddings[0]}')

def chat(chat_model: ChatModel):
    print(chat_model.ask("Ping"), end='\n\n\n')
    chat_model.pretty("Ping")
    chat_model.close()

def embed_Ollama():
    embed(EmbeddingModel(model='bge-m3:latest', provider='ollama'))

def embed_OpenAI():
    embed(EmbeddingModel(model='text-embedding-3-small', provider='openai'))

def embed_WebUI():
    embed(EmbeddingModel(model='bge-m3:latest', provider='openwebui'))

def llm_Ollama():
    chat(ChatModel(model='qwen3.5:4b', provider='ollama'))

def llm_OpenAI():
    chat(ChatModel(model='gpt-5.6-luna'))

def llm_WebUI():
    chat(ChatModel(model='qwen3.5:4b', provider='openwebui'))

def ollama():
    embed_Ollama()
    llm_Ollama()

def openai():
    embed_OpenAI()
    llm_OpenAI()

def openwebui():
    embed_WebUI()
    llm_WebUI()

def every():
    ollama()
    openai()
    openwebui()