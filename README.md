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

<img width="2048" height="760" alt="789926583_1770857050782852_4526728086700753933_n" src="https://github.com/user-attachments/assets/c6d57e3e-d954-4202-8881-41e15471c82c" />
<img width="2048" height="737" alt="789775842_1770857097449514_1147125559042365321_n" src="https://github.com/user-attachments/assets/90c70a74-e35a-4048-96da-4904c95e6f8b" />
<img width="2048" height="819" alt="791335182_1770857144116176_4332431700745370197_n" src="https://github.com/user-attachments/assets/b7b640a0-47fa-41db-9dfc-0f84ce69b03d" />

