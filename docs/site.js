// Highlight the nav link of the section in view. The page works without this.
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav li a'));
  if (!('IntersectionObserver' in window) || !links.length) return;
  var byId = {};
  links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      links.forEach(function (a) { a.classList.remove('on'); a.removeAttribute('aria-current'); });
      var a = byId[e.target.id];
      if (a) { a.classList.add('on'); a.setAttribute('aria-current', 'true'); }
    });
  }, { rootMargin: '-40% 0px -55% 0px' });
  Object.keys(byId).forEach(function (id) { var s = document.getElementById(id); if (s) io.observe(s); });
})();
