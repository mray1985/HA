import { lazy, Suspense, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Gamepad2, LayoutPanelLeft, NotebookPen, ScanText } from 'lucide-react';
import { useLiveCalculation } from '../../hooks/useLiveCalculation';
import ThreeScreens from './ThreeScreens';
import { TaxGame, Taxtionary } from './LearningTools';
import HAKeeper from './HAKeeper';
import TaxRadio from './TaxRadio';
import './ha-workspace.css';
const TaxPacketReader = lazy(() => import('./TaxPacketReader'));

export default function HAWorkspace({ educationOnly = false }: { educationOnly?: boolean }) {
  const [tab, setTab] = useState(educationOnly ? 'game' : new URLSearchParams(window.location.search).get('view') === 'statements' ? 'statements' : 'screens');
  const [lesson, setLesson] = useState(0);
  const navigate = useNavigate();
  const { calculationError } = useLiveCalculation();
  const tabs = [{ id: 'screens', label: 'Three screens', icon: LayoutPanelLeft }, { id: 'statements', label: 'Statements', icon: ScanText }, { id: 'game', label: 'Tax game', icon: Gamepad2 }, { id: 'dictionary', label: 'Taxtionary', icon: BookOpen }, { id: 'keeper', label: 'HAKeeper', icon: NotebookPen }];
  return <div className="ha-workspace"><header className="ha-header"><button className="ha-brand" onClick={() => navigate('/')}>HA <span>TAX</span></button><span className="ha-tagline">Your return, made clear.</span><nav aria-label="HA workspace">{tabs.map(t => <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}><t.icon size={18} />{t.label}</button>)}</nav></header>
    <div className="ha-content">{calculationError && <p role="alert">{calculationError}</p>}{tab === 'screens' && (educationOnly ? <section className="ha-learning"><h1>Your three-screen workspace</h1><p>Unlock a return, then choose Three-screen workspace from the interview.</p><button onClick={() => navigate('/')}>Open dashboard</button></section> : <ThreeScreens />)}{tab === 'game' && <TaxGame />}{tab === 'dictionary' && <Taxtionary />}{tab === 'keeper' && (educationOnly ? <section className="ha-learning"><h2>HAKeeper</h2><p>Open an unlocked return to use the encrypted expense ledger.</p><button onClick={() => navigate('/')}>Open dashboard</button></section> : <HAKeeper onListen={() => { setLesson(1); document.querySelector('.ha-radio')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }} />)}
      <>{tab === "statements" && (educationOnly ? <section className="ha-learning"><h2>Statement reader</h2><p>Open an unlocked return to read its K-1 / K-3 packet.</p><button onClick={() => navigate("/")}>Open dashboard</button></section> : <Suspense fallback={<p>Opening the text reader…</p>}><TaxPacketReader /></Suspense>)}</><TaxRadio lesson={lesson} onLesson={setLesson} /><footer className="ha-footer"><span>Explore more in HA Tax</span><button onClick={() => setTab('game')}><Gamepad2 />Tax game <small>Practice tax scenarios and build knowledge.</small></button><button onClick={() => setTab('keeper')}><NotebookPen />HAKeeper <small>Keep expenses organized for tax time.</small></button></footer>
    </div></div>;
}
