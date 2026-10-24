const reviewsText=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const reviewStars=rating=>Array.from({length:5},(_,index)=>`<span class="star ${index<Math.round(Number(rating)||0)?'on':''}" aria-hidden="true">★</span>`).join('');
const reviewDate=value=>{const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'})};
const reviewForm=(product)=>`<form class="review-product-form" data-review-form="${product.id}">
  <h3>${product.active===false?'Share feedback on this upcoming product':'Share your experience'}</h3>
  <label>Your name<input name="name" maxlength="80" required></label>
  <label>Your rating<select name="rating" required><option value="5">5 — Excellent</option><option value="4">4 — Very good</option><option value="3">3 — Good</option><option value="2">2 — Fair</option><option value="1">1 — Poor</option></select></label>
  <label class="review-message-field">Your review<textarea name="text" maxlength="1200" rows="3" required></textarea></label>
  <button class="primary" type="submit">Submit review</button>
  <p class="review-message" role="status" aria-live="polite">Reviews are checked before they appear publicly.</p>
</form>`;
function reviewCard(product){
  const reviews=product.reviews||[],rating=Number(product.rating)||0;
  const visible=reviews.length?`<div class="review-product-reviews">${reviews.map(review=>`<article class="review"><header>${reviewStars(review.rating)}<b>${reviewsText(review.name)}</b><span class="muted">${reviewsText(reviewDate(review.date))}</span></header><p>${reviewsText(review.text)}</p></article>`).join('')}</div>`:'<p class="review-empty">No approved reviews yet. Be the first to share feedback.</p>';
  return `<article class="review-product-card">
    <a href="/product.html?id=${encodeURIComponent(product.id)}" aria-label="View ${reviewsText(product.name)}"><img class="review-product-image" src="/${reviewsText(product.img)}" alt="${reviewsText(product.name)}" loading="lazy"></a>
    <div class="review-product-details">
      <div class="review-product-topline"><span class="review-product-badge${product.active===false?' upcoming-badge':''}">${product.active===false?'COMING SOON':'CUSTOMER REVIEWS'}</span><span class="review-product-rating">${reviewStars(rating)} <span>${rating.toFixed(1)} · ${Number(product.reviewCount)||0} reviews</span></span></div>
      <h2><a href="/product.html?id=${encodeURIComponent(product.id)}">${reviewsText(product.name)}</a></h2>
      ${visible}
      ${reviewForm(product)}
    </div>
  </article>`;
}
document.querySelector('#reviewsProducts').addEventListener('submit',async event=>{
  const form=event.target.closest('[data-review-form]');if(!form)return;
  event.preventDefault();const button=form.querySelector('button[type="submit"]'),message=form.querySelector('.review-message'),fields=new FormData(form);
  button.disabled=true;message.textContent='';
  try{
    const response=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:Number(form.dataset.reviewForm),name:fields.get('name'),rating:Number(fields.get('rating')),text:fields.get('text')})}),result=await response.json().catch(()=>({}));
    if(!response.ok)throw Error(result.error||'Unable to submit your review.');
    form.reset();message.textContent=result.message
  }catch(error){message.textContent=error.message}
  finally{button.disabled=false}
});
async function loadReviewsPage(){
  const status=document.querySelector('#reviewsPageStatus');
  try{
    const response=await fetch('/api/store');if(!response.ok)throw Error('Unable to load products and reviews.');
    const data=await response.json(),products=data.products||[];
    document.querySelector('#reviewsProducts').innerHTML=products.length?products.map(reviewCard).join(''):'<p class="review-empty">No products are available yet.</p>';
    status.textContent=`${products.length} product${products.length===1?'':'s'} · Customer reviews are published after approval.`
  }catch(error){status.textContent=error.message}
}
loadReviewsPage();
