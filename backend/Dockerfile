# Verwende Debian als Basis für Scala/Play und installiere Java, ffmpeg sowie sbt per tarball
FROM debian:latest

RUN apt-get update && apt-get install -y curl default-jre ffmpeg neovim && \
    mkdir -p /opt && \
    curl -L -o /tmp/sbt.tgz https://github.com/sbt/sbt/releases/download/v1.12.11/sbt-1.12.11.tgz && \
    tar -xzf /tmp/sbt.tgz -C /opt && \
    rm -f /tmp/sbt.tgz && \
    ln -s /opt/sbt/bin/sbt /usr/local/bin/sbt

# Setze das Arbeitsverzeichnis
WORKDIR /app

# Kopiere die Projektdateien
COPY . .

# Installiere Abhängigkeiten
RUN sbt update

# Exponiere den Port
EXPOSE 9000


# Starte die Anwendung mit sbt run
CMD ["sbt", "run"]

#comment to bield and run container
# docker build -t backend .
# docker run -p 9000:9000 backend

