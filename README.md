# 🌊 Fluid Mesh Studio HD

> An advanced generative art studio & Color DNA analyzer built with vanilla JavaScript and HTML5 Canvas.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-5.8-green.svg)
![Pure JS](https://img.shields.io/badge/vanilla-JS-yellow.svg)

---

## 🔗 Live Demo

Experience the tool directly in your browser:

**[Click here to Launch](https://hieu-bit346.github.io/fluid-mesh-studio/)**

---

## 📖 Overview

**Fluid Mesh Studio HD** extracts key color palettes from uploaded images and generates fluid mesh waves, paper-cut layers, aurora fields, or angular polygon graphics. It features interactive character/item info card creation, real-time hue shifting, radar metrics visualization, and color palette exportation.

---

## ✨ Features

* **Advanced Generative Art:** Supports 4 render modes: *Mesh Glow*, *Paper Cut*, *Aurora*, and *Polygon*.
* **Color DNA Analysis:** Evaluates Diversity, Colorfulness, Monochromatic balance, Warmth, and Brightness via an interactive Radar Chart.
* **Manual Crop Tool:** Circular crop modal with live zoom and position tracking.
* **Info Card Studio:** Customizable dual-frame card generator (Avatar & Cover layout) exported directly to high-res PNG.
* **Palette Export:** Export color schemes as standard `.GPL` (GIMP/Photoshop compatible) or copy CSS variable snippets.
* **Animation & Video Export:** Live preview and WebM video recording.
* **Comparison & Composite Board:** Save outputs to compare color metrics and generate grid composite sheets.

---

## 📁 Project Structure

```text
fluid-mesh-studio/
├── index.html        # Main markup, modals & application state
├── css/
│   └── style.css     # UI styles, theme variables, and layouts
├── js/
│   ├── color.js      # Color algorithms (HSV, K-Means, Diversity, Metrics)
│   ├── renderer.js   # Canvas vector rendering (Waves, Grain, Radar)
│   ├── crop-ui.js    # Interactive circular crop modal logic
│   ├── storage.js    # LocalStorage management & comparison board
│   └── app.js        # Main UI event listeners & state controller
└── README.md         # Project documentation
