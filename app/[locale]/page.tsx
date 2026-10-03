import { SuiPoolLanding } from '../../components/SuiPoolLanding';

// The homepage reads only the live per-asset signal (the coin strip) and
// the health check (the safety line); neither needs a preload.
export default function HomePage() {
  return <SuiPoolLanding />;
}
