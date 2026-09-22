(function () {
  document.querySelectorAll('.mobile-nav').forEach(function (menu) {
    var summary = menu.querySelector('summary');

    menu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        menu.removeAttribute('open');
      });
    });

    menu.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && menu.open) {
        menu.removeAttribute('open');
        summary.focus();
      }
    });

    document.addEventListener('click', function (event) {
      if (menu.open && !menu.contains(event.target)) {
        menu.removeAttribute('open');
      }
    });
  });
})();
