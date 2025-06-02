# Verwende ein OpenJDK-Image für Scala/Play Framework
FROM debian:latest

RUN apt update && apt install -y curl default-jre

# Installiere Java und sbt
RUN echo "deb https://repo.scala-sbt.org/scalasbt/debian all main" > /etc/apt/sources.list.d/sbt.list && \
    echo "deb https://repo.scala-sbt.org/scalasbt/debian /" > /etc/apt/sources.list.d/sbt_old.list && \
	curl -sL "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x2EE0EA64E40A89B84B2DF73499E82A75642AC823" > /etc/apt/trusted.gpg.d/sbt.asc && \
	apt-get update && \
	apt-get install -y sbt ffmpeg

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

