import { supabase } from './supabase.js';
import { renderLogin } from './views/login.js';
import { renderApp } from './views/app.js';
import './style.css';

async function init() {
  const { data: { session } } = await supabase.auth.getSession();

  if (session) {
    renderApp(session);
  } else {
    renderLogin();
  }

  // Listen for auth state changes
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      renderApp(session);
    } else {
      renderLogin();
    }
  });
}

init();
