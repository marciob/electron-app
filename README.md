# Electron React Application

A professional desktop application built with Electron, React, TypeScript, and Tailwind CSS.

## 🚀 Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)

### Installation

```bash
npm install
```

### Development

To run the application in development mode:

```bash
npm run electron:dev
```

### Production Build

To create a production build:

```bash
npm run electron:build
```

## 🛠 Developer Tools

### Opening DevTools

You can open the Chrome DevTools to inspect the application:

- **On macOS**: Press `Cmd + Option + I`
- **On Windows/Linux**: Press `Ctrl + Shift + I`

### Available Scripts

- `npm run dev` - Start Vite development server
- `npm run build` - Build the application
- `npm run electron:dev` - Start Electron in development mode
- `npm run electron:build` - Build the application for production

## 📁 Project Structure

```
├── src/
│   ├── main/           # Electron main process
│   └── renderer/       # React application (renderer process)
├── dist/              # Production build output
└── dist-electron/    # Electron main process build output
```

## 🔧 Tech Stack

- Electron
- React
- TypeScript
- Tailwind CSS
- Vite

## 📝 License

This project is open source and available under the MIT License.
