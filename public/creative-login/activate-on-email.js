/*
 * Our adapter — NOT part of the demo. `script.js` stays byte-identical.
 *
 * Why this exists: the demo only spins its gear train when its optional
 * "name" field looks filled (nameValid). An operator who types an e-mail and
 * a password — the two things that matter — would therefore never see the
 * submit button animate, because the spray that reveals the button text is
 * driven by those gears.
 *
 * So we drive the SAME timelines from the e-mail instead. The demo declares
 * `gearsTls`, `sprayRepeatCounter` and `submitBtn` at the top level of a
 * classic script, which puts them in the global lexical scope: this file,
 * loaded after it, can read and drive them without touching a line of the
 * demo. Nothing here authenticates anything — it only moves the artwork.
 */
(function () {
  var emailEl = document.querySelector('.form-container input[name="email"]');
  var nameEl = document.querySelector('.form-container input[name="name"]');
  if (!emailEl || !window.gsap) return;

  var EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  var timelines = typeof gearsTls !== "undefined" ? gearsTls : [];

  function spin(up) {
    if (up) {
      timelines.forEach(function (tl) {
        if (tl.paused()) {
          tl.play();
          window.gsap.fromTo(tl, { timeScale: 0 }, { timeScale: 1 });
        }
      });
      return;
    }
    timelines.forEach(function (tl) {
      if (!tl.paused()) {
        window.gsap.to(tl, {
          timeScale: 0,
          onComplete: function () {
            tl.pause();
          },
        });
      }
    });
    // Reset the spray counter so the button text fades in again from zero.
    if (typeof sprayRepeatCounter !== "undefined") sprayRepeatCounter = 0;
    if (typeof submitBtn !== "undefined") {
      window.gsap.to(submitBtn, { duration: 0.3, color: "rgba(0, 0, 0, 0)" });
    }
  }

  function sync() {
    spin(EMAIL_RE.test(emailEl.value));
  }

  emailEl.addEventListener("input", sync);
  // The demo's own name handler can pause the gears; a valid e-mail wins.
  if (nameEl) nameEl.addEventListener("input", sync);
  sync();
})();