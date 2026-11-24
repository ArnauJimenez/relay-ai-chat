import { useState, type FormEvent } from "react";
import { ArrowRight, Bot, LoaderCircle, LockKeyhole, Mail, Sparkles, UserRound } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { getApiErrorMessage } from "../services/api";

export function AuthScreen() {
  const { login, loginAsGuest, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "register") {
        await register({ email, username, password });
      } else {
        await login(email, password);
      }
    } catch (requestError) {
      setError(getApiErrorMessage(requestError, "Sign in failed. Please try again."));
    } finally {
      setLoading(false);
    }
  }

  async function handleGuestLogin() {
    setError("");
    setDemoLoading(true);
    try {
      await loginAsGuest();
    } catch (requestError) {
      setError(
        getApiErrorMessage(
          requestError,
          "No pudimos crear la sesión demo. Revisa tu conexión e inténtalo de nuevo en unos segundos.",
        ),
      );
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-visual">
        <div className="auth-visual-grid" />
        <div className="auth-brand"><span className="brand-mark"><Bot size={19} /></span> relay<span className="brand-dot">.</span></div>
        <div className="auth-story">
          <div className="eyebrow"><span className="eyebrow-line" /> A quieter kind of conversation</div>
          <h1>Ideas move<br />better <em>together.</em></h1>
          <p>Where thoughtful teams meet intelligent tools. A workspace for conversations that go somewhere.</p>
          <div className="story-orbit" aria-hidden="true">
            <div className="orbit-ring orbit-ring-one" />
            <div className="orbit-ring orbit-ring-two" />
            <span className="orbit-center"><Sparkles size={23} /></span>
            <span className="orbit-dot orbit-dot-a" />
            <span className="orbit-dot orbit-dot-b" />
            <span className="orbit-dot orbit-dot-c" />
          </div>
        </div>
        <div className="auth-visual-footer"><span>BUILT FOR THE WAY YOU THINK</span><span>01 — 03</span></div>
      </section>

      <section className="auth-form-side">
        <div className="auth-form-wrap">
          <div className="mobile-brand"><span className="brand-mark"><Bot size={19} /></span> relay<span className="brand-dot">.</span></div>
          <div className="form-kicker">YOUR WORKSPACE AWAITS</div>
          <h2>{mode === "login" ? "Welcome back." : "Make yourself at home."}</h2>
          <p className="auth-subtitle">
            {mode === "login" ? "Pick up right where the conversation left off." : "Create an account and bring your ideas in."}
          </p>

          <form onSubmit={handleSubmit} className="auth-form">
            <label className="field-label" htmlFor="email">Email address</label>
            <div className="input-shell"><Mail size={17} /><input id="email" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></div>

            {mode === "register" && <>
              <label className="field-label" htmlFor="username">Username</label>
              <div className="input-shell"><UserRound size={17} /><input id="username" type="text" autoComplete="username" placeholder="how people know you" minLength={3} maxLength={30} pattern="[a-zA-Z0-9_]+" value={username} onChange={(event) => setUsername(event.target.value)} required /></div>
            </>}

            <div className="password-label"><label className="field-label" htmlFor="password">Password</label>{mode === "login" && <span>At least 8 characters</span>}</div>
            <div className="input-shell"><LockKeyhole size={17} /><input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="••••••••••••" minLength={8} maxLength={72} value={password} onChange={(event) => setPassword(event.target.value)} required /></div>

            {error && <div className="form-error" role="alert">{error}</div>}
            <button type="submit" className="primary-button auth-submit" disabled={loading || demoLoading}>
              {loading ? <LoaderCircle size={18} className="spin" /> : <>{mode === "login" ? "Sign in to Relay" : "Create your account"} <ArrowRight size={17} /></>}
            </button>
          </form>

          {mode === "login" && <>
            <div className="auth-divider" aria-hidden="true"><span>o</span></div>
            <button type="button" className="guest-button" onClick={() => void handleGuestLogin()} disabled={loading || demoLoading} aria-busy={demoLoading}>
              {demoLoading ? <><LoaderCircle size={17} className="spin" /> Creando tu sesión demo…</> : <>Entrar como invitado / Demo <Sparkles size={16} /></>}
            </button>
            <p className="guest-note">Sesión temporal de 24 h con un chat privado y un asistente de IA listos para probar.</p>
          </>}

          <div className="auth-switch">
            {mode === "login" ? "New to Relay?" : "Already have an account?"}
            <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </div>
          <div className="auth-terms">By continuing, you agree to our <a href="#terms">Terms</a> and <a href="#privacy">Privacy Policy</a>.</div>
        </div>
        <div className="auth-corner-note"><span className="status-dot" /> ALL SYSTEMS OPERATIONAL</div>
      </section>
    </main>
  );
}
