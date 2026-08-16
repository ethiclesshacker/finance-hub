// ======================================================
// Third-party UI libraries, bundled rather than loaded from CDNs.
//
// These used to arrive as globals from four separate CDN <script>/<link> tags
// in index.html: jsDelivr (Chart.js + date adapter), unpkg (Grid.js), cdnjs
// (Font Awesome) and Google Fonts. That put four render-blocking third parties
// on the critical path with no SRI and no fallback. Bundling them lets the
// production CSP stay at `default-src 'self'`.
// ======================================================

import Chart from 'chart.js/auto';   // /auto registers every controller, scale and element
import 'chartjs-adapter-date-fns';   // required by the `type: 'time'` x-axes
import { Grid, html as gridHtml } from 'gridjs';

import 'gridjs/dist/theme/mermaid.css';
import '@fortawesome/fontawesome-free/css/all.min.css';
import '@fontsource-variable/inter';

export { Chart, Grid, gridHtml };
