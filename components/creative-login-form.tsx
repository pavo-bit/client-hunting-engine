"use client";

// Creative operator sign-in form.
//
// Provenance: the artwork, the form styling and the whole animation timeline
// are the owner's reference demo (`Creative Login Form/`), ported to React:
//
//   - `public/creative-login/style.css`  - verbatim copy of the demo styles
//   - `public/creative-login/script.js`  - verbatim copy of the demo timeline
//   - GSAP is the pinned npm dependency, NOT the demo's unpkg CDN script
//
// What changed versus the demo, and why:
//
//   1. A PASSWORD field was added. The demo had only name + e-mail + a consent
//      checkbox and no authentication at all, so it could not gate anything.
//   2. Submission is handled by React and goes to the existing
//      `POST /api/auth/login`. Credentials are verified SERVER-side against
//      the scrypt hash in the environment. Nothing is compared in the browser,
//      no credential is hardcoded here, and the password is never logged.
//   3. The animation is cosmetic: the demo hid the submit button until its own
//      counters finished. Here the button is always operable and Enter always
//      submits, so nobody can be locked out by the animation. The demo script
//      only runs its visuals and is never allowed to block a sign-in.
//   4. Labels, autocomplete and error text are real: a placeholder-only form
//      is not accessible, and this page is the app's front door.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/** The whole scene renders 50% larger than a plain fit-to-window. */
const SCENE_BOOST = 1.5;

type State =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "error"; message: string; detail?: string };

export function CreativeLoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const mounted = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // The demo artwork is a fixed 1000×1000 stage with the form centred inside
  // it, and its cord geometry is computed in SVG user units. The app shell is
  // narrower than 1000px, so the whole stage is scaled by ONE factor — scaling
  // the SVG alone would slide the artwork off the checkbox and the button.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const available = el.clientWidth || window.innerWidth;
      // Uniform scale for the whole 1000×1000 stage: the cord geometry is in
      // SVG user units, so the artwork and the form must always shrink
      // together. Height budget leaves room for the page header and help line.
      const heightBudget = Math.max(240, window.innerHeight - 230);
      const fit = Math.max(0.32, Math.min(1, available / 1000, heightBudget / 1000));
      // Owner's request: the scene runs 50% larger than a plain fit-to-window.
      // One multiplier scales the entire composition - artwork, cords, gears,
      // input boxes - so nothing drifts out of alignment. Letter size is NOT
      // multiplied: the form's type is divided back out by --creative-inverse
      // in app/globals.css, so the words stay exactly 15px on screen.
      const scale = fit * SCENE_BOOST;
      el.style.setProperty("--creative-scale", String(scale));
      el.style.setProperty("--creative-inverse-boost", String(1 / SCENE_BOOST));
      el.style.setProperty("--creative-stage-height", `${Math.round(1000 * scale)}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Load the demo's animation once, after the SVG is in the DOM. GSAP comes
  // from the bundled dependency; the demo's CDN tag is never used.
  useEffect(() => {
    let cancelled = false;
    let scriptEl: HTMLScriptElement | null = null;
    // The demo's scaleToFit() writes an inline GSAP transform onto `.container`
    // (viewport-height only) and re-applies it on every resize. Our stage
    // scaling considers width AND height, so we take ownership of that element
    // once the demo has run and disarm its resize handler. Everything the demo
    // animates (gears, cord, spray, spiral) is untouched.
    const takeOverStage = () => {
      const stage = stageRef.current;
      const container = document.querySelector<HTMLElement>(".creative-login .container");
      if (!stage || !container) return;
      const apply = () => {
        const scale = getComputedStyle(stage).getPropertyValue("--creative-scale").trim();
        if (!scale) return;
        container.style.transformOrigin = "center center";
        container.style.transform = `translate(-50%, -50%) scale(${scale})`;
      };
      apply();
      window.onresize = null;
      window.addEventListener("resize", apply);
    };
    const start = async () => {
      const gsap = (await import("gsap")).default;
      if (cancelled) return;
      (window as unknown as { gsap: typeof gsap }).gsap = gsap;
      const load = (src: string, marker: string, after?: () => void) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = false;
        s.dataset.creativeLogin = marker;
        if (after) s.addEventListener("load", after, { once: true });
        document.body.appendChild(s);
        return s;
      };
      // Order matters: the demo timeline first, then our adapter that drives
      // the submit animation from the e-mail field (see the file header).
      load("/creative-login/script.js", "demo", () => {
        scriptEl = load("/creative-login/activate-on-email.js", "adapter", takeOverStage);
      });
    };
    void start();
    return () => {
      cancelled = true;
      // Demo script installs its own listeners/GSAP tweens; on leaving the page
      // it has nothing left to animate, so only our injected tags are removed.
      for (const el of Array.from(document.querySelectorAll<HTMLScriptElement>("script[data-creative-login]"))) {
        el.parentNode?.removeChild(el);
      }
    };
  }, []);

  const canSubmit = EMAIL_RE.test(email.trim()) && password.length > 0 && state.kind !== "busy";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) {
      setState({
        kind: "error",
        message: "Enter your operator e-mail and password to continue.",
      });
      return;
    }
    setState({ kind: "busy" });
    let res: Response;
    try {
      res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, next }),
      });
    } catch {
      setState({
        kind: "error",
        message: "Could not reach the server.",
        detail: "Check that the app is running locally and retry.",
      });
      return;
    }
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { next?: string };
      const target = typeof data.next === "string" && data.next.startsWith("/") ? data.next : "/";
      mounted.current = true;
      router.push(target);
      router.refresh();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    // Deliberately generic: the server never says whether an account exists,
    // and neither do we (no enumeration oracle in the UI either).
    setState({
      kind: "error",
      message:
        body.code === "rate_limited" || res.status === 429
          ? "Too many attempts. Wait a few minutes and try again."
          : "Sign-in failed.",
      detail:
        body.code === "auth_unavailable"
          ? "No operator credential is provisioned on this machine."
          : "Check the e-mail and password, then try again.",
    });
    setPassword("");
  }

  return (
    <div className="creative-login">
      <link rel="stylesheet" href="/creative-login/style.css" />
      <div className="creative-login-stage" ref={stageRef}>
        <div className="container">
        <form
          className="form-container"
          onSubmit={onSubmit}
          noValidate
          aria-describedby="creative-login-help"
        >
          <label className="form-row">
            <span className="sr-only">Operator name (optional)</span>
            <input
              autoComplete="name"
              type="text"
              id="name"
              name="name"
              placeholder="name"
              aria-label="Operator name (optional, not used to sign in)"
            />
          </label>

          <label className="form-row">
            <span className="sr-only">Operator e-mail</span>
            <input
              autoComplete="username"
              type="email"
              id="email"
              name="email"
              placeholder="e-mail"
              aria-label="Operator e-mail"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>

          <label className="form-row">
            <span className="sr-only">Password</span>
            <input
              autoComplete="current-password"
              type="password"
              id="password"
              name="password"
              placeholder="password"
              aria-label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          <label className="form-row" id="creative-login-help">
            <input type="checkbox" id="subscribe" name="subscribe" />
            <span>I understand this is an internal tool</span>
          </label>

          {state.kind === "error" && (
            <div className="form-row" role="alert">
              <span className="text-xs text-red-700">
                {state.message}
                {state.detail ? ` ${state.detail}` : ""}
              </span>
            </div>
          )}

          <div className="form-row">
            <input
              type="submit"
              value={state.kind === "busy" ? "signing in…" : "submit"}
              aria-busy={state.kind === "busy"}
            />
          </div>
        </form>

        {/* Artwork below is the demo's SVG, verbatim, so the copied animation
            script finds every class it was written against. */}
        <svg viewBox="0 0 1000 1000" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="710" y="527" width="16" height="47" rx="10" ry="10" />

          <g className="grabbing-hand">
            <path d="M48.89,54.39c-3.51.76-15.72,3-22.83-.68a14,14,0,0,0-6.41-1.52h0A3.79,3.79,0,0,1,17,51.09a3.7,3.7,0,0,1-1.1-2.64V27.75A3.75,3.75,0,0,1,19.63,24H24.1" />
            <path className="grabbing-hand-finger-open" d="M57.05,29.76l24.82,0a4.07,4.07,0,0,0,4.11-4h0a4.07,4.07,0,0,0-4-4.11L48.69,21.3" />
            <path className="grabbing-hand-finger-open" d="M59.34,37.74l28.81.61a4.06,4.06,0,0,0,4.14-4h0a4.06,4.06,0,0,0-4-4.15L57,29.64" />
            <path className="grabbing-hand-finger-open" d="M57.13,45.9l26.94.78a4.07,4.07,0,0,0,4.15-4h0a4.07,4.07,0,0,0-4-4.14l-24.84-.8" />
            <path className="grabbing-hand-finger-open" d="M48.89,54.39l27.82.36a4.06,4.06,0,0,0,4.2-3.93h0A4.06,4.06,0,0,0,77,46.62l-19.88-.78" />
            <path className="grabbing-hand-finger-open" d="M40.78,28c5.75-5.85,12.66-22,10.5-25.88-2.25-4.09-6 .1-14.73,8.66C30.84,16.36,30.91,17.1,24.32,24" />
          </g>

          <g className="pull-system">
            <line className="checkbox-pull-line" x1="0" y1="0" x2="0" y2="0" />
            <g className="checkbox-pull-circle">
              <circle cx="0" cy="0" r="10" />
              <circle cx="0" cy="0" r="4" fill="#000000" />
            </g>
            <circle className="submit-btn-circle" cx="0" cy="0" r="3" stroke="none" fill="#000" />
            <path className="submit-btn-connector" d="" />
          </g>

          <g className="spray-hand-container">
            <g className="pushing-hand">
              <circle cx="18" cy="0" r="5" fill="#000000" />
              <circle cx="18" cy="-70" r="5" fill="#000000" />
              <path d="M18,-70 v70" strokeWidth="4" />
              <g>
                <path d="M25.3,32.9V60.2a4.2,4.2,0,0,0,4.2,4.2h0a4.2,4.2,0,0,0,4.2-4.2V26.7" />
                <rect x="3.9" y="18.4" width="8.4" height="21.47" rx="3.7" transform="translate(10.2 -1) rotate(19.4)" />
                <path d="M20.9,24a3.4,3.4,0,0,0-1.7-1.1h0a4.2,4.2,0,0,0-5.4,2.5L9.1,38.8a4.3,4.3,0,0,0,2.6,5.4h0a4.3,4.3,0,0,0,5.4-2.6l1.8-5.1" />
                <path d="M18.4,37.9,17.3,43a4.2,4.2,0,0,0,3.4,4.9h0a4.3,4.3,0,0,0,4.5-2.3" />
                <path
                  fill="white"
                  d="M29,16.8c-6.4,5-15,13.2-12.8,17.8s6,.7,15.8-6.7c6.4-4.8,7.4-12.6.5-19.2V4.2A3.8,3.8,0,0,0,28.7.5H8A3.5,3.5,0,0,0,5.4,1.6,3.7,3.7,0,0,0,4.3,4.2V8.7"
                />
                <path d="M4.3,8.7c-5.8,6.4-3.6,20-2.2,24.8" />
              </g>
            </g>
            <g className="sprayer">
              <g className="sprayer-head">
                <defs>
                  <radialGradient id="grad1" cx="50%" cy="50%" r="50%" fx="100%" fy="50%">
                    <stop offset="0%" stopColor="#777777" stopOpacity="0" />
                    <stop offset="100%" stopColor="#777777" stopOpacity="1" />
                  </radialGradient>
                </defs>
                <rect x="82.39" y="19.85" width="13.06" height="16.79" rx="1.46" />
                <rect x="74.55" y="22.56" width="7.84" height="6.1" rx="1.13" />

                <line className="spray-line" stroke="#777777" strokeDasharray="8 5" x1="22.4" y1="14.76" x2="74.27" y2="25.2" />
                <line className="spray-line" stroke="#777777" strokeDasharray="8 5" x1="21.51" y1="21.12" x2="74.27" y2="25.2" />
                <line className="spray-line" stroke="#777777" strokeDasharray="8 5" x1="21.44" y1="28.26" x2="74.27" y2="25.2" />
                <line className="spray-line" stroke="#777777" strokeDasharray="8 5" x1="22.37" y1="35.54" x2="74.27" y2="25.2" />
                <line className="spray-line" stroke="#777777" strokeDasharray="8 5" x1="24.21" y1="42.36" x2="74.27" y2="25.2" />
                <line className="spray-line" stroke="#777777" strokeDasharray="8 5" x1="24.31" y1="7.78" x2="74.27" y2="25.2" />

                <circle fill="url(#grad1)" stroke="none" className="spray-bubble" cx="25.43" cy="12.97" r="12.47" />
                <circle fill="url(#grad1)" stroke="none" className="spray-bubble" cx="15.6" cy="25.43" r="15.1" />
                <circle fill="url(#grad1)" stroke="none" className="spray-bubble" cx="33.24" cy="37.13" r="9.21" />
                <circle fill="url(#grad1)" stroke="none" className="spray-bubble" cx="35.92" cy="19.5" r="11.89" />
                <circle fill="url(#grad1)" stroke="none" className="spray-bubble" cx="18.82" cy="34.45" r="11.89" />
              </g>
              <path
                d="M89,42h0a21.3,21.3,0,0,1,21.3,21.3v56.48a5.06,5.06,0,0,1-5.06,5.06H72.6a5.06,5.06,0,0,1-5.06-5.06V63.4A21.45,21.45,0,0,1,89,42Z"
                fill="#fff"
              />
              <rect x="78.3" y="36.64" width="21.24" height="6.15" rx="1.93" fill="#fff" />
              <rect x="76.33" y="71.46" width="33.96" height="23.23" fill="#cccccc" />
            </g>
          </g>

          <g>
            <line className="gear-connector" x1="0" x2="0" y1="0" y2="0" />
            <g className="gears" />
          </g>

          <g className="grabbing-hand">
            <g fill="#ffffff">
              <rect
                className="grabbing-hand-finger-closed"
                x="44.79"
                y="13.38"
                width="8.42"
                height="22.15"
                rx="3.67"
                transform="translate(20.57 71.26) rotate(-85.25)"
              />
              <rect
                className="grabbing-hand-finger-closed"
                x="44.08"
                y="39.17"
                width="8.42"
                height="21.47"
                rx="3.67"
                transform="translate(-5.44 93.9) rotate(-85.25)"
              />
              <rect
                className="grabbing-hand-finger-closed"
                x="45.68"
                y="30.71"
                width="8.42"
                height="22.57"
                rx="3.67"
                transform="matrix(0.08, -1, 1, 0.08, 3.91, 88.24)"
              />
              <rect
                className="grabbing-hand-finger-closed"
                x="44.98"
                y="22.21"
                width="8.42"
                height="22.57"
                rx="3.67"
                transform="matrix(0.08, -1, 1, 0.08, 11.74, 79.74)"
              />
              <path
                className="grabbing-hand-finger-closed"
                d="M32.18,27.42c5,6.46,13.22,15.06,17.76,12.81,4.18-2.07.69-6-6.66-15.74C38.46,18.1,30.69,17.1,24.1,24"
              />
            </g>
          </g>

          <g className="spiral-container">
            <path strokeWidth=".8" className="spiral-path" d="" />
          </g>

          <g className="weight-big-container">
            <line x1="14" x2="60" y1="14" y2="14" />
            <line x1="14" x2="60" y1="14" y2="55" />
            <circle cx="14" cy="14" r="5" fill="#000000" stroke="none" />

            <g className="weight-big" stroke="none">
              <path
                d="M25.5,16.7c.2-.6.5-1.3.7-2C31.1,3.1,23.2,0,14.3,0S-1.6,4.2,2.4,14.7a22.5,22.5,0,0,1,.8,2.4A14.4,14.4,0,0,0,0,26.2c0,8,6.5,11.6,14.5,11.6S29,34.2,29,26.2A14.6,14.6,0,0,0,25.5,16.7ZM14.4,5c5.6,0,9.3,1.9,7.1,8.5a13.5,13.5,0,0,0-7-1.8,14.6,14.6,0,0,0-7.2,1.8C5.5,7.5,8.8,5,14.4,5Z"
                fill="#231f20"
              />
              <path d="M15.1,15.6l-1.8-.2a9.2,9.2,0,0,0-9.1,9.2,6.2,6.2,0,0,0,.2,1.9A13.3,13.3,0,0,1,15.1,15.6Z" fill="#fff" />
            </g>
          </g>

          <g className="scales-container">
            <defs>
              <marker
                id="ball"
                viewBox="0 0 10 10"
                refX="5"
                refY="5"
                markerUnits="strokeWidth"
                markerWidth="5"
                markerHeight="5"
                orient="auto"
              >
                <circle cx="5" cy="5" r="3" fill="#000" />
              </marker>
            </defs>

            <rect x="10" y="-19" width="30" height="90" rx="15" ry="15" strokeWidth="10" stroke="#ccc" />
            <rect className="timing-chain" x="10" y="-19" width="30" height="90" rx="15" ry="15" strokeWidth="10" stroke="#fff" />

            <rect x="-31" y="-19" width="30" height="144" rx="15" ry="15" strokeWidth="10" stroke="#ccc" />
            <rect className="timing-chain" x="-31" y="-19" width="30" height="144" rx="15" ry="15" strokeWidth="10" stroke="#fff" />

            <g className="reels-connector">
              <rect x="-8" y="3.2" width="25" height="10" rx="5" ry="5" />
              <circle cx="-1" cy="8.5" r="3" fill="#000" stroke="none" />
              <circle cx="9.9" cy="8.5" r="3" fill="#000" stroke="none" />
            </g>

            <g className="car-weight-connector">
              <rect x="-36" y="97" width="10" height="95" rx="5" ry="5" />
              <circle cx="-31" cy="103" r="3" fill="#000" stroke="none" />
              <circle cx="-31" cy="186" r="3" fill="#000" stroke="none" />
            </g>

            <line className="scales-moving-line" x1="147.6" y1="30.52" x2="40" y2="12" strokeWidth="2" markerStart="url(#ball)" markerEnd="url(#ball)" />
            <path fill="#000000" d="M102.45,30.68,92,20.26c-9.89,9.9-9.89,10.47-9.89,10.47Z" />
          </g>

          <g className="car-container">
            <g>
              <g className="car">
                <circle cx="17" cy="88" r="5" />
                <circle cx="17" cy="88" r="2" fill="#000" />
                <circle cx="32" cy="88" r="5" />
                <circle cx="32" cy="88" r="2" fill="#000" />

                <path d="M10,65 h30 l-5,15 h-20 l-5,-15 " fill="#000" />
              </g>

              <line x1="-51" y1="95" x2="145" y2="95" />
            </g>
          </g>
        </svg>
        </div>
      </div>

      <p className="creative-login-footer">
        Local internal tool — one authorized operator. Credentials are verified on
        this machine only; nothing is sent anywhere else.{" "}
        <Link href="/" className="underline">
          Back to the dashboard
        </Link>{" "}
        (you will be asked to sign in again).
      </p>
    </div>
  );
}