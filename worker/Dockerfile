FROM python:3.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "playwright==1.*" && useradd -u 1000 -m app
USER app
WORKDIR /app
COPY --chown=app extract.py worker.py /app/
HEALTHCHECK --interval=5m --start-period=3m --start-interval=30s --timeout=10s CMD python -c "import time,sys; sys.exit(0 if time.time()-float(open('/tmp/healthy').read())<900 else 1)"
CMD ["python", "-u", "worker.py"]
