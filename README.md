# FinanceHub — Personal Finance Command Centre

FinanceHub is an all-in-one personal finance command centre designed to help you track your net worth snapshots, asset distribution, emergency runway, and credit card points & redemptions.

It is structured as a fast, light, single-page application (SPA) powered by standard web technologies and integrated with Supabase for real-time database persistence.

---

## 🚀 Key Features

*   **Wealth & Net Worth Dashboard:** Real-time summary of total assets, liabilities, estimated passive income, and FI progress target.
*   **Emergency Runway Tracker:** Automatically calculates your baseline expense runway based on liquid assets vs. monthly outgoings.
*   **Asset Allocation Charting:** Dynamic, responsive breakdown of your assets (Stocks, MFs, Cash, EPF, Gold, FDs) using Chart.js.
*   **Points & Rewards (HSBC TravelOne):** Full log of transaction spends, earned reward multipliers (0× to 24×), and transfer partner redemptions.
*   **Advanced Data Table Controls:**
    *   Responsive tables powered by Grid.js.
    *   Global text search filtering.
    *   Column-specific drop-down filters (Year filter for Net Worth; Multiplier and Merchant filters for Transactions; Transfer Partner filter for Redemptions).
    *   Excel-compatible CSV exports for offline analysis.

---

## 🛠️ Tech Stack

*   **Frontend Logic:** Vanilla Javascript (ES6 modules) + HTML5 + CSS3 (glassmorphic theme).
*   **Routing:** Custom hash-based client-side router (`/#dashboard`, `/#networth`, `/#points`).
*   **Bundler:** [Vite](https://vite.dev/) (fast, module-focused development environment).
*   **Charts:** [Chart.js](https://www.chartjs.org/) + `chartjs-adapter-date-fns`.
*   **Tables:** [Grid.js](https://gridjs.io/).
*   **Backend:** [Supabase](https://supabase.com/) (Authentication and Database APIs).

---

## 📦 Getting Started

### 1. Prerequisites
Ensure you have [Node.js](https://nodejs.org/) installed (v18+ recommended).

### 2. Setup Database Environment
Clone/copy the environment variable template:
```bash
cp .env.example .env
```
Open `.env` and fill in your Supabase connection credentials:
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-project-publishable-anon-key
```

### 3. Installation
Install project dependencies:
```bash
npm install
```

### 4. Development Server
Start the local hot-reloading development server:
```bash
npm run dev
```
Open your browser to the displayed URL (typically `http://localhost:5173`).

### 5. Production Build
Compile and minify the project assets into a clean production bundle (output to `dist/` directory):
```bash
npm run build
```
To preview the compiled assets locally:
```bash
npm run preview
```
