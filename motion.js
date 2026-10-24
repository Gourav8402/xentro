/* Shared scroll-reveal: adds .in to any .reveal element once it enters the viewport. */
(function(){
  const els=document.querySelectorAll('.reveal');
  if(!els.length)return;
  if(!('IntersectionObserver' in window)){els.forEach(e=>e.classList.add('in'));return}
  const io=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('in');io.unobserve(entry.target)}})},{threshold:.15,rootMargin:'0px 0px -60px 0px'});
  els.forEach(e=>io.observe(e));
})();
