(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ================= i18n ================= */
  var body = document.body;
  var htmlEl = document.documentElement;

  function applyLang(lang) {
    body.setAttribute("data-lang", lang);
    htmlEl.setAttribute("lang", lang === "zh" ? "zh-CN" : "en");
    document.querySelectorAll(".i18n").forEach(function (el) {
      var text = el.getAttribute("data-" + lang);
      if (text !== null) el.textContent = text;
    });
    document.querySelectorAll(".lang-en").forEach(function (el) {
      el.style.display = lang === "zh" ? "none" : "inline";
    });
    document.querySelectorAll(".lang-zh").forEach(function (el) {
      el.style.display = lang === "zh" ? "inline" : "none";
    });
    try { localStorage.setItem("wedding-lang", lang); } catch (e) {}
    if (typeof updateOutfitLabel === "function") updateOutfitLabel();
  }

  function initLang() {
    var saved = null;
    try { saved = localStorage.getItem("wedding-lang"); } catch (e) {}
    var lang = saved || (navigator.language && navigator.language.toLowerCase().indexOf("zh") === 0 ? "zh" : "en");
    applyLang(lang);
  }

  document.getElementById("langToggle").addEventListener("click", function () {
    var current = body.getAttribute("data-lang");
    applyLang(current === "en" ? "zh" : "en");
  });

  initLang();

  /* ================= countdown ================= */
  var WEDDING_DATE = new Date("2026-12-20T15:30:00-10:00"); // 3:30pm HST, guest arrival

  function tickCountdown() {
    var now = new Date();
    var diff = WEDDING_DATE - now;
    if (diff < 0) diff = 0;
    var days = Math.floor(diff / 86400000);
    var hours = Math.floor((diff % 86400000) / 3600000);
    var mins = Math.floor((diff % 3600000) / 60000);
    var secs = Math.floor((diff % 60000) / 1000);
    setText("cd-days", days);
    setText("cd-hours", pad(hours));
    setText("cd-mins", pad(mins));
    setText("cd-secs", pad(secs));
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  tickCountdown();
  setInterval(tickCountdown, 1000);

  /* ================= add to calendar ================= */
  function buildICS() {
    var start = WEDDING_DATE;
    var end = new Date("2026-12-20T23:30:00-10:00");
    function fmt(d) {
      return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    }
    var lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Catherine & Haolin Wedding//EN",
      "BEGIN:VEVENT",
      "UID:catherine-haolin-wedding-20261220@wedding.local",
      "DTSTAMP:" + fmt(new Date()),
      "DTSTART:" + fmt(start),
      "DTEND:" + fmt(end),
      "SUMMARY:Catherine & Haolin's Wedding",
      "DESCRIPTION:Guest Arrival 3:30pm, Ceremony 4:30pm, Cocktail Hour 5:30pm, Dinner Reception 6:30pm, After Party 8:30pm.",
      "LOCATION:Lanikuhonua, O'ahu, Hawaii",
      "END:VEVENT",
      "END:VCALENDAR"
    ];
    return lines.join("\r\n");
  }

  function downloadICS() {
    var blob = new Blob([buildICS()], { type: "text/calendar" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "catherine-haolin-wedding.ics";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  ["calBtn", "calBtn2"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (btn) btn.addEventListener("click", downloadICS);
  });

  /* ================= music toggle ================= */
  var bgm = document.getElementById("bgm");
  var musicBtn = document.getElementById("musicToggle");
  var playing = false;

  function playMusic(onFail) {
    var p = bgm.play();
    if (p && p.then) {
      p.then(function () {
        playing = true;
        updateMusicIcon();
      }).catch(function (err) {
        if (onFail) onFail(err);
      });
    } else {
      playing = true;
      updateMusicIcon();
    }
  }

  musicBtn.addEventListener("click", function () {
    if (!playing) {
      playMusic(function () {
        showToast(body.getAttribute("data-lang") === "zh"
          ? "还没有添加音乐文件哦～把 mp3 放进 music 文件夹即可"
          : "No music file yet — drop an mp3 into the /music folder");
      });
    } else {
      bgm.pause();
      playing = false;
      updateMusicIcon();
    }
  });

  // WeChat's in-app browser (X5 / WKWebView) doesn't treat a normal click as a
  // user gesture for audio the way Safari/Chrome do. WeChat fires this event
  // once its own bridge is ready, and play() called from inside it is exempt
  // from that restriction — this is the standard fix for "won't autoplay in WeChat".
  document.addEventListener("WeixinJSBridgeReady", function () {
    if (!playing) playMusic();
  }, false);

  // Extra safety net: if the envelope tap didn't manage to unlock audio
  // (some WeChat versions are inconsistent), try again on the very next
  // touch/click anywhere on the page, once, without bothering the user.
  var unlockTried = false;
  function unlockOnFirstInteraction() {
    if (unlockTried || playing) return;
    unlockTried = true;
    playMusic();
    document.removeEventListener("touchend", unlockOnFirstInteraction);
    document.removeEventListener("click", unlockOnFirstInteraction);
  }
  document.addEventListener("touchend", unlockOnFirstInteraction);
  document.addEventListener("click", unlockOnFirstInteraction);

  function updateMusicIcon() {
    musicBtn.querySelector(".icon-note").style.display = playing ? "none" : "block";
    musicBtn.querySelector(".icon-mute").style.display = playing ? "block" : "none";
    musicBtn.setAttribute("aria-pressed", playing ? "true" : "false");
  }

  /* ================= toast ================= */
  var toastEl = document.getElementById("toast");
  var toastTimer = null;
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2600);
  }

  /* ================= snitch easter egg ================= */
  var snitchMessages = [
    { en: "A little magic ✨", zh: "一点点魔法 ✨" },
    { en: "Aloha! 🌺", zh: "阿罗哈！🌺" },
    { en: "You caught it!", zh: "被你抓到啦！" },
    { en: "See you in Hawaii 🌴", zh: "夏威夷见啦 🌴" }
  ];
  var snitch = document.getElementById("snitch");
  if (snitch) {
    snitch.addEventListener("click", function (e) {
      e.stopPropagation();
      var lang = body.getAttribute("data-lang");
      var msg = snitchMessages[Math.floor(Math.random() * snitchMessages.length)];
      showToast(msg[lang]);
      burstConfetti(e.clientX, e.clientY);
    });

    if (!reduceMotion) {
      (function scheduleDepthFlip() {
        setTimeout(function () {
          snitch.classList.toggle("behind");
          scheduleDepthFlip();
        }, 3500 + Math.random() * 4500);
      })();
    }
  }

  /* ================= lightweight confetti burst ================= */
  var confettiCanvas = document.getElementById("particles");
  var ctx = confettiCanvas.getContext("2d");
  var confettiParticles = [];

  function drawSparkle(x, y, size, alpha, color) {
    ctx.save();
    ctx.globalAlpha = Math.max(alpha, 0);
    ctx.fillStyle = color;
    ctx.font = size + "px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("✦", x, y);
    ctx.restore();
  }

  function burstConfetti(x, y) {
    if (reduceMotion) return;
    for (var i = 0; i < 22; i++) {
      var angle = Math.random() * Math.PI * 2;
      var speed = 2 + Math.random() * 4;
      confettiParticles.push({
        x: x, y: y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        life: 50, maxLife: 50,
        size: 10 + Math.random() * 8,
        color: Math.random() > 0.5 ? "#c9a15a" : "#7c5e28"
      });
    }
  }

  /* ================= snitch sparkle trail ================= */
  var snitchTrail = [];
  var snitchLastPos = null;
  var trailFrameCount = 0;

  function updateSnitchTrail() {
    if (reduceMotion || !snitch) return;
    trailFrameCount++;
    if (trailFrameCount % 2 !== 0) return;
    var rect = snitch.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    if (snitchLastPos) {
      snitchTrail.push({
        x: cx + (Math.random() * 16 - 8),
        y: cy + (Math.random() * 16 - 8),
        life: 60, maxLife: 60,
        size: 14 + Math.random() * 16,
        drift: (Math.random() * 0.8 - 0.4)
      });
    }
    snitchLastPos = { x: cx, y: cy };
    if (snitchTrail.length > 110) snitchTrail.shift();
  }

  /* ================= ambient floating particles ================= */
  var ambient = [];
  function resizeCanvas() {
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  function initAmbient() {
    var count = reduceMotion ? 0 : (window.innerWidth < 700 ? 14 : 28);
    for (var i = 0; i < count; i++) {
      ambient.push({
        x: Math.random() * confettiCanvas.width,
        y: Math.random() * confettiCanvas.height,
        r: 1 + Math.random() * 2.4,
        speed: 0.15 + Math.random() * 0.35,
        drift: Math.random() * 0.6 - 0.3,
        phase: Math.random() * Math.PI * 2
      });
    }
  }
  initAmbient();

  function animate() {
    ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);

    // ambient sparkles
    ambient.forEach(function (p) {
      p.y -= p.speed;
      p.x += Math.sin(p.phase + p.y * 0.01) * p.drift * 0.3;
      if (p.y < -10) { p.y = confettiCanvas.height + 10; p.x = Math.random() * confettiCanvas.width; }
      ctx.beginPath();
      ctx.fillStyle = "rgba(163,130,58,0.35)";
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    });

    // snitch sparkle trail
    updateSnitchTrail();
    for (var t = snitchTrail.length - 1; t >= 0; t--) {
      var s = snitchTrail[t];
      s.life -= 1;
      s.y += s.drift;
      if (s.life <= 0) { snitchTrail.splice(t, 1); continue; }
      var fade = s.life / s.maxLife;
      drawSparkle(s.x, s.y, s.size * (0.6 + fade * 0.4), fade * 0.9, "#e8c26a");
    }

    // confetti burst
    for (var i = confettiParticles.length - 1; i >= 0; i--) {
      var c = confettiParticles[i];
      c.x += c.vx;
      c.y += c.vy;
      c.vy += 0.08;
      c.life -= 1;
      if (c.life <= 0) { confettiParticles.splice(i, 1); continue; }
      drawSparkle(c.x, c.y, c.size, c.life / c.maxLife, c.color);
    }

    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  /* ================= scroll reveal ================= */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    revealEls.forEach(function (el) { revealObserver.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in-view"); });
  }

  /* ================= side nav ================= */
  var navDots = document.querySelectorAll(".side-nav .dot");
  var sections = Array.prototype.map.call(navDots, function (dot) {
    return document.getElementById(dot.getAttribute("data-target"));
  });

  navDots.forEach(function (dot) {
    dot.addEventListener("click", function () {
      var target = document.getElementById(dot.getAttribute("data-target"));
      if (target) target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    });
  });

  if ("IntersectionObserver" in window) {
    var navObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var idx = sections.indexOf(entry.target);
          navDots.forEach(function (d) { d.classList.remove("active"); });
          if (navDots[idx]) navDots[idx].classList.add("active");
        }
      });
    }, { threshold: 0.5 });
    sections.forEach(function (s) { if (s) navObserver.observe(s); });
  }

  /* ================= map hotspot tooltips ================= */
  var hotspots = document.querySelectorAll(".hotspot");
  var tipItems = document.querySelectorAll(".tip-item");
  hotspots.forEach(function (spot) {
    spot.addEventListener("click", function () {
      var key = spot.getAttribute("data-tip");
      var target = document.querySelector('.tip-item[data-tip-for="' + key + '"]');
      tipItems.forEach(function (t) { t.classList.remove("highlight"); });
      if (target) {
        target.classList.add("highlight");
        target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "nearest" });
      }
    });
  });

  /* ================= dress code mood glow ================= */
  var dressFrame = document.getElementById("dressFrame");
  var outfitLabel = document.getElementById("outfitLabel");
  var swatchBtns = document.querySelectorAll("#swatchRow .swatch");

  function updateOutfitLabel() {
    if (!outfitLabel) return;
    var lang = body.getAttribute("data-lang");
    var activeSwatch = document.querySelector("#swatchRow .swatch.active");
    if (!activeSwatch) return;
    outfitLabel.textContent = activeSwatch.getAttribute("data-" + lang);
  }

  swatchBtns.forEach(function (sw) {
    sw.addEventListener("click", function () {
      swatchBtns.forEach(function (s) { s.classList.remove("active"); });
      sw.classList.add("active");
      if (dressFrame) {
        dressFrame.style.setProperty("--mood-color", sw.getAttribute("data-color"));
        dressFrame.classList.remove("glow");
        void dressFrame.offsetWidth;
        dressFrame.classList.add("glow");
      }
      updateOutfitLabel();
    });
  });

  updateOutfitLabel();

  /* ================= lightbox gallery ================= */
  var images = ["1.jpg", "2.jpg", "3.jpg", "4.jpg", "5.jpg", "6.jpg"];
  var lightbox = document.getElementById("lightbox");
  var lbImg = document.getElementById("lbImg");
  var currentIndex = 0;

  function openLightbox(index) {
    currentIndex = index;
    lbImg.src = images[currentIndex];
    lbImg.classList.remove("zoomed");
    lightbox.classList.add("open");
    lightbox.setAttribute("aria-hidden", "false");
  }
  function closeLightbox() {
    lightbox.classList.remove("open");
    lightbox.setAttribute("aria-hidden", "true");
  }
  function showRelative(delta) {
    currentIndex = (currentIndex + delta + images.length) % images.length;
    lbImg.classList.remove("zoomed");
    lbImg.src = images[currentIndex];
  }

  document.querySelectorAll("[data-lightbox]").forEach(function (img) {
    img.addEventListener("click", function () {
      openLightbox(parseInt(img.getAttribute("data-lightbox"), 10));
    });
  });

  document.getElementById("lbClose").addEventListener("click", closeLightbox);
  document.getElementById("lbPrev").addEventListener("click", function () { showRelative(-1); });
  document.getElementById("lbNext").addEventListener("click", function () { showRelative(1); });
  lbImg.addEventListener("click", function () { lbImg.classList.toggle("zoomed"); });
  lightbox.addEventListener("click", function (e) {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", function (e) {
    if (!lightbox.classList.contains("open")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") showRelative(-1);
    if (e.key === "ArrowRight") showRelative(1);
  });

  /* ================= back to top ================= */
  document.getElementById("toTop").addEventListener("click", function () {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  });

  /* ================= envelope gate ================= */
  var gate = document.getElementById("gate");
  var envelopeBtn = document.getElementById("envelopeBtn");
  if (gate && envelopeBtn) {
    var gateOpened = false;
    envelopeBtn.addEventListener("click", function () {
      if (gateOpened) return;
      gateOpened = true;
      playMusic();

      if (reduceMotion) {
        gate.classList.add("gate-exit");
        body.classList.remove("gate-active");
        setTimeout(function () { gate.style.display = "none"; }, 650);
        return;
      }

      gate.classList.add("wand-tap");
      setTimeout(function () {
        var r = envelopeBtn.getBoundingClientRect();
        burstConfetti(r.left + r.width / 2, r.top + r.height * 0.58);
        gate.classList.add("opening");
      }, 1150);
      setTimeout(function () {
        gate.classList.add("gate-exit");
        body.classList.remove("gate-active");
      }, 1950);
      setTimeout(function () { gate.style.display = "none"; }, 2550);
    });
  }

})();
