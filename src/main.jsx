import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './styles.css';

// The same bundle serves the main window and the output windows
// (index.html?view=video / ?view=prompter), which never load Firebase.
const root = createRoot(document.getElementById('root'));
const view = new URLSearchParams(window.location.search).get('view');

if (view === 'video') {
  import('./VideoWindow.jsx').then(({ default: VideoWindow }) => root.render(<VideoWindow />));
} else if (view === 'prompter') {
  import('./PrompterWindow.jsx').then(({ default: PrompterWindow }) => root.render(<PrompterWindow />));
} else {
  import('./App.jsx').then(({ default: App }) => root.render(<App />));
}
