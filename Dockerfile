FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .
# functions-framework picks up PORT from the environment (Cloud Run sets it).
ENV PORT=8080
EXPOSE 8080
CMD ["functions-framework", "--target=bridge", "--source=src/charter/main.py"]
