FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

RUN python3 -m venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

COPY ru-backend/requirements.txt ./ru-backend/requirements.txt

RUN pip install --no-cache-dir -r ru-backend/requirements.txt

COPY . .

ENV PORT=10000
ENV PYTHON_API_PORT=8001

EXPOSE 10000

CMD ["node", "server/index.js"]
