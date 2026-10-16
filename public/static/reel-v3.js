(function () {
  "use strict";

  var shelf = document.querySelector(".shelf");
  var shelfWindow = document.querySelector(".shelf-window");
  var siteNav = document.querySelector(".site-nav");
  var mobileShelf = window.matchMedia("(max-width: 800px)");
  var shelfManual = false;
  var shelfTouchStart = null;
  var opening = document.querySelector(".opening");
  var stage = document.querySelector(".story-stage");
  var chapters = Array.from(document.querySelectorAll("[data-step]"));
  var controls = Array.from(document.querySelectorAll("[data-step-link]"));
  var status = document.getElementById("request-status");
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var labels = [
    "Find your next watch",
    "Requested. Follow its progress.",
    "Available. Put your feet up.",
  ];
  var currentStep = -1;
  var framePending = false;

  function updateShelfScroll() {
    if (!shelfWindow) {
      return;
    }
    var automatic =
      mobileShelf.matches && !reducedMotion.matches && !shelfManual;
    shelfWindow.classList.toggle("scroll-linked", automatic);
    if (!automatic) {
      return;
    }

    var rect = shelfWindow.getBoundingClientRect();
    var endTop = (siteNav ? siteNav.getBoundingClientRect().bottom : 66) + 24;
    var startTop = Math.max(
      window.innerHeight - Math.min(rect.height, window.innerHeight * 0.4) - 16,
      endTop + 120,
    );
    var progress = Math.max(
      0,
      Math.min(1, (startTop - rect.top) / (startTop - endTop)),
    );
    shelfWindow.scrollLeft =
      progress * (shelfWindow.scrollWidth - shelfWindow.clientWidth);
  }

  function takeShelfControl() {
    shelfManual = true;
    shelfWindow.classList.remove("scroll-linked");
  }

  if (shelfWindow) {
    // Vertical gestures still move the page; a horizontal gesture keeps the shelf.
    shelfWindow.addEventListener(
      "touchstart",
      function (event) {
        var touch = event.touches.length === 1 ? event.touches[0] : null;
        shelfTouchStart = touch ? { x: touch.clientX, y: touch.clientY } : null;
      },
      { passive: true },
    );
    shelfWindow.addEventListener(
      "touchmove",
      function (event) {
        if (!shelfTouchStart || event.touches.length !== 1) {
          return;
        }
        var dx = Math.abs(event.touches[0].clientX - shelfTouchStart.x);
        var dy = Math.abs(event.touches[0].clientY - shelfTouchStart.y);
        if (dx > 8 && dx > dy * 1.2) {
          takeShelfControl();
        }
      },
      { passive: true },
    );
    ["touchend", "touchcancel"].forEach(function (name) {
      shelfWindow.addEventListener(
        name,
        function () {
          shelfTouchStart = null;
        },
        { passive: true },
      );
    });
    shelfWindow.addEventListener(
      "wheel",
      function (event) {
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey) {
          takeShelfControl();
        }
      },
      { passive: true },
    );
    shelfWindow.addEventListener("focusin", takeShelfControl);
  }

  function updateScene() {
    framePending = false;
    updateShelfScroll();
    if (shelf && opening) {
      var distance = Math.max(
        0,
        Math.min(
          1,
          -opening.getBoundingClientRect().top / opening.offsetHeight,
        ),
      );
      shelf.style.setProperty(
        "--shelf-shift",
        reducedMotion.matches ? "0px" : -distance * 65 + "px",
      );
      shelf.style.setProperty(
        "--shelf-turn",
        reducedMotion.matches ? "0deg" : distance * 9 + "deg",
      );
    }
    if (!stage || !chapters.length) {
      return;
    }
    var active = 0;
    var readingLine = window.innerHeight * 0.55;
    if (
      window.getComputedStyle(stage).position === "sticky" &&
      window.innerWidth <= 800
    ) {
      readingLine = Math.max(
        readingLine,
        stage.getBoundingClientRect().bottom + 40,
      );
    }
    chapters.forEach(function (chapter, index) {
      if (chapter.getBoundingClientRect().top <= readingLine) {
        active = index;
      }
    });
    if (currentStep === active) {
      return;
    }
    currentStep = active;
    stage.setAttribute("data-active", String(active));
    status.textContent = labels[active];
    var notification = stage.querySelector(".push-notice");
    if (notification) {
      notification.setAttribute("aria-hidden", String(active !== 2));
    }
    controls.forEach(function (link, index) {
      if (index === active) {
        link.setAttribute("aria-current", "step");
      } else {
        link.removeAttribute("aria-current");
      }
    });
    var screens = stage.querySelectorAll(".app-screen");
    screens.forEach(function (screen, index) {
      screen.setAttribute(
        "aria-hidden",
        String(index === 0 ? active === 2 : active !== 2),
      );
    });
  }
  function scheduleScene() {
    if (!framePending) {
      framePending = true;
      window.requestAnimationFrame(updateScene);
    }
  }
  // Scroll stays native. One paint is scheduled only when the visitor moves.
  window.addEventListener("scroll", scheduleScene, { passive: true });
  window.addEventListener("resize", scheduleScene);
  if (reducedMotion.addEventListener) {
    reducedMotion.addEventListener("change", scheduleScene);
  }
  if (mobileShelf.addEventListener) {
    mobileShelf.addEventListener("change", scheduleScene);
  }
  updateScene();

  var copy = document.querySelector(".copy-btn");
  if (copy && navigator.clipboard && window.isSecureContext) {
    copy.hidden = false;
    copy.addEventListener("click", function () {
      var code = document.querySelector(".compose code");
      var feedback = document.querySelector(".copy-status");
      navigator.clipboard
        .writeText(code.textContent)
        .then(function () {
          feedback.textContent = "Compose file copied.";
        })
        .catch(function () {
          feedback.textContent =
            "Select the compose file below and copy it manually.";
          var range = document.createRange();
          range.selectNodeContents(code);
          var selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
    });
  }

  function openDialogFromHash() {
    if (location.hash !== "#android-beta") {
      return;
    }
    var dialog = document.getElementById("android-beta");
    if (!dialog || dialog.open) {
      return;
    }
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
    var first = dialog.querySelector("[autofocus]");
    if (first) {
      first.focus();
    }
  }
  document.querySelectorAll("dialog").forEach(function (dialog) {
    function clearHash() {
      if (location.hash === "#" + dialog.id) {
        history.replaceState(null, "", location.pathname + location.search);
      }
    }
    function closeDialog() {
      if (typeof dialog.close === "function") {
        dialog.close();
      } else {
        dialog.removeAttribute("open");
      }
      clearHash();
    }
    dialog.addEventListener("close", clearHash);
    dialog.addEventListener("cancel", clearHash);
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) {
        closeDialog();
      }
    });
    dialog.querySelectorAll("[data-close-dialog]").forEach(function (button) {
      button.addEventListener("click", closeDialog);
    });
  });
  window.addEventListener("hashchange", openDialogFromHash);
  openDialogFromHash();
})();
