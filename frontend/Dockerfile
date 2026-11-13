# Node.js image
FROM node:latest

RUN apt-get update && apt-get install -y neovim && rm -rf /var/lib/apt/lists/*

# Working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the code
COPY . .

# Port of the dev server
EXPOSE 3000

# Start the app in development mode
CMD ["npm", "start"]

# comment to build and run container
# docker build -t frontend .
# docker run -p 3000:3000 frontend