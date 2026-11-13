# Debian base for Scala/Play with Java, ffmpeg and sbt (from the tarball)
FROM debian:latest

RUN apt-get update && apt-get install -y curl default-jre ffmpeg neovim && \
    mkdir -p /opt && \
    curl -L -o /tmp/sbt.tgz https://github.com/sbt/sbt/releases/download/v1.12.11/sbt-1.12.11.tgz && \
    tar -xzf /tmp/sbt.tgz -C /opt && \
    rm -f /tmp/sbt.tgz && \
    ln -s /opt/sbt/bin/sbt /usr/local/bin/sbt

# Working directory
WORKDIR /app

# Copy the project files
COPY . .

# Fetch dependencies
RUN sbt update

# Port
EXPOSE 9000


# Start the app with sbt run
CMD ["sbt", "run"]

#comment to bield and run container
# docker build -t backend .
# docker run -p 9000:9000 backend

