FROM nvcr.io/nvidia/pytorch:26.07-py3

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY classifier_service.py ./classifier_service.py

EXPOSE 8101
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8101/health',headers={'Authorization':'Bearer '+os.environ.get('CRM_AI_API_KEY','')}); urllib.request.urlopen(r,timeout=4).read()"
CMD ["python", "-m", "uvicorn", "classifier_service:app", "--host", "0.0.0.0", "--port", "8101", "--no-access-log"]
