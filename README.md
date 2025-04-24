# Getting Started with Trimly using Docker Compose

Follow these steps to set up and run Trimly using Docker Compose:

## Prerequisites
- Install [Docker](https://www.docker.com/get-started) and [Docker Compose](https://docs.docker.com/compose/install/) on your system.

## Steps

1. **Clone the Repository**:
    ```bash
    git clone https://github.com/arthu/Trimly.git
    cd Trimly
    ```

2. **Start the Application**:
    Run the following command to start the application:
    ```bash
    docker-compose up -d
    ```

3. **Access the Application**:
    Open your browser and navigate to `http://localhost:3000`.

## Stopping the Application
To stop the running services:
```bash
docker-compose down
```

You're all set to use Trimly with Docker Compose!


## Updating the Application

To update Trimly to the latest version:

1. **Pull the Latest Changes**:
    Navigate to the project directory and pull the latest changes:
    ```bash
    git pull origin main
    ```

2. **Rebuild the Services**:
    Rebuild the Docker images to apply the updates:
    ```bash
    docker-compose build
    ```

3. **Restart the Application**:
    Restart the application to apply the updates:
    ```bash
    docker-compose up -d
    ```

You're now running the latest version of Trimly!