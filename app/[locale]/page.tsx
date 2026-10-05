import { SuiPoolLanding } from '../../components/SuiPoolLanding';

// The homepage's only live read is the health check (the safety line), which
// needs no preload. It shows no live signals: that read is slow when its
// backend is, and the first screen must not wait on it.
export default function HomePage() {
  return <SuiPoolLanding />;
}
