'use client';

/**
 * The chart library and its one registration, in their own chunk: the NAV
 * card's layout, numbers and data load without waiting for chart.js.
 */
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

export default Line;
