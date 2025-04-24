# Verwende ein Node.js-Image
FROM node:latest

# Setze das Arbeitsverzeichnis
WORKDIR /app

# Kopiere package.json und package-lock.json
COPY package*.json ./

# Installiere Abhängigkeiten
RUN npm install

# Kopiere den Rest des Codes
COPY . .

# Exponiere den Port für die Entwicklungsumgebung
EXPOSE 3000

# Starte die Anwendung im Entwicklungsmodus
CMD ["npm", "start"]