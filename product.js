/* Product detail page: loads managed catalogue data and keeps the existing product layout. */
const productText=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
function stars(rating){const full=Math.round(rating);return Array.from({length:5},(_,index)=>`<span class="star ${index<full?'on':''}">★</span>`).join('')}
async function loadProductPage(){
  try{
    const response=await fetch('/api/store');if(!response.ok)throw Error('Unable to load this product.');
    const data=await response.json();products=data.products;storeCategories=data.categories;homeContent=data.home;renderCart();
    const productId=Number(new URLSearchParams(location.search).get('id')),product=products.find(entry=>entry.id===productId);
    if(!product){location.href='index.html';return}
    document.title=`${product.name} | Xentro Enterprises`;$('#crumbName').textContent=product.name;
    const comingSoon=product.active===false,unavailable=comingSoon||product.stock===0,oldPrice=Number(product.old)||0,discount=oldPrice?Math.round((1-product.price/oldPrice)*100):0;
    const images=Array.isArray(product.images)&&product.images.length?product.images:[product.img];
    $('#pdp').innerHTML=`
      <div class="pdp-gallery"><img id="productMainImage" src="${productText(images[0])}" alt="${productText(product.imageAlt||product.name)}">${images.length>1?`<div class="product-thumbnails" role="group" aria-label="Product images">${images.map((image,index)=>`<button class="product-thumbnail${index===0?' active':''}" type="button" data-gallery-image="${index}" aria-label="View image ${index+1} of ${productText(product.name)}" aria-pressed="${index===0}"><img src="${productText(image)}" alt="" loading="lazy"></button>`).join('')}</div>`:''}</div>
      <div class="pdp-info">
        <em class="tag">${productText(comingSoon?'COMING SOON':product.stock===0?'OUT OF STOCK':product.offerText||product.tag)}</em>
        <h1>${productText(product.name)}</h1>
        <div class="rating-line">${stars(product.rating||0)}<span>${Number(product.rating||0).toFixed(1)} · ${Number(product.reviewCount||0)} reviews</span></div>
        <div class="price-line"><span class="price">${money(product.price)}</span>${oldPrice?`<span class="old">${money(oldPrice)}</span><span class="off">${discount}% off</span>`:''}</div>
        <p class="desc">${productText(product.description)}</p>
        <p class="stock-message ${unavailable?'stock-unavailable':''}" id="productStock">${comingSoon?'Coming soon':product.stock===0?'Out of stock':product.stock===null||product.stock===undefined?'In stock':`${product.stock} in stock`}</p>
        <div class="qty-row"><label for="qty">Qty</label><div class="quantity"><button type="button" id="qtyMinus" aria-label="Decrease quantity" ${unavailable?'disabled':''}>−</button><span id="qtyVal">1</span><button type="button" id="qtyPlus" aria-label="Increase quantity" ${unavailable?'disabled':''}>+</button></div></div>
        <div class="pdp-actions"><button class="primary wide" id="pdpAdd" ${unavailable?'disabled':''}>${comingSoon?'Coming soon':unavailable?'Out of stock':'Add to cart'}</button><button class="secondary wide" id="pdpBuy" ${unavailable?'disabled':''}>${comingSoon?'Coming soon':'Buy now'}</button></div>
        <ul class="features">${(product.features||[]).map(feature=>`<li>${productText(feature)}</li>`).join('')}</ul>
        <table class="specs"><tbody>${Object.entries(product.specs||{}).map(([key,value])=>`<tr><th>${productText(key)}</th><td>${productText(value)}</td></tr>`).join('')}</tbody></table>
      </div>`;
    $('#pdp').querySelectorAll('[data-gallery-image]').forEach(button=>button.onclick=()=>{const index=Number(button.dataset.galleryImage);$('#productMainImage').src=images[index];$('#pdp').querySelectorAll('[data-gallery-image]').forEach(thumbnail=>{const active=thumbnail===button;thumbnail.classList.toggle('active',active);thumbnail.setAttribute('aria-pressed',String(active))})});
    let quantity=1;const maxQuantity=product.stock===null||product.stock===undefined?10:Math.min(10,product.stock);
    $('#qtyMinus').onclick=()=>{quantity=Math.max(1,quantity-1);$('#qtyVal').textContent=quantity};
    $('#qtyPlus').onclick=()=>{quantity=Math.min(maxQuantity,quantity+1);$('#qtyVal').textContent=quantity};
    $('#pdpAdd').onclick=()=>addToCart(product.id,quantity);
    $('#pdpBuy').onclick=()=>{addToCart(product.id,quantity);$('#checkoutOpen').click()};
    $('#reviewSummary').innerHTML=`<div class="score"><strong>${Number(product.rating||0).toFixed(1)}</strong>${stars(product.rating||0)}<span>${Number(product.reviewCount||0)} reviews</span></div>`;
    $('#reviewList').innerHTML=(product.reviews||[]).map(review=>`<article class="review"><header>${stars(review.rating)}<b>${productText(review.name)}</b><span class="muted">${productText(new Date(review.date).toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}))}</span></header><p>${productText(review.text)}</p></article>`).join('')||'<p class="empty-review">No approved reviews yet. Be the first to share your experience.</p>';
    $('#reviewForm').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]'),fields=new FormData(form);
      button.disabled=true;$('#reviewMessage').textContent='';
      try{const response=await fetch('/api/reviews',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:product.id,name:fields.get('name'),rating:Number(fields.get('rating')),text:fields.get('text')})}),result=await response.json().catch(()=>({}));if(!response.ok)throw Error(result.error||'Unable to submit your review.');form.reset();$('#reviewMessage').textContent=result.message}
      catch(error){$('#reviewMessage').textContent=error.message}
      finally{button.disabled=false}
    };
    const related=[...products.filter(entry=>entry.id!==product.id),...products.filter(entry=>entry.id!==product.id)];
    $('#relatedTrack').innerHTML=related.map(entry=>`<article class="related-card" data-open="${entry.id}"><img src="${productText(entry.img)}" alt="${productText(entry.name)}" loading="lazy"><div><h3>${productText(entry.name)}</h3><span class="price">${money(entry.price)}</span></div></article>`).join('');
    $('#relatedTrack').onclick=event=>{const card=event.target.closest('[data-open]');if(card)location.href=`product.html?id=${encodeURIComponent(card.dataset.open)}`};
  }catch(error){toast(error.message)}
}
loadProductPage();
