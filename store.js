/* Home page only: loads the managed catalogue and renders storefront cards. */
const storeText=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
function renderProducts(){
  const featured=homeContent.featuredProductIds||[];
  const available=products.filter(product=>product.active!==false);
  const shown=featured.length?available.filter(product=>featured.includes(product.id)):available.filter(product=>product.featured);
  const category=document.querySelector('#categoryFilters .active')?.dataset.category||'';
  const featuredList=shown.length?shown:available;
  const listing=(category?products.filter(product=>product.category===category):featuredList);
  $('#categoryFilters').innerHTML=['All',...storeCategories].map(name=>`<button type="button" class="category-filter${(category||'All')===name?' active':''}" data-category="${name==='All'?'':storeText(name)}" aria-pressed="${(category||'All')===name}">${storeText(name)}</button>`).join('');
  $('#products').innerHTML=listing.map(product=>{
    const comingSoon=product.active===false,unavailable=comingSoon||product.stock===0,offer=product.offerText||product.tag;
    return `<article class="product${unavailable?' out-of-stock':''}${comingSoon?' upcoming':''}" data-open="${product.id}"><img src="${storeText(product.img)}" alt="${storeText(product.imageAlt||product.name)}" loading="lazy"><div><em>${storeText(comingSoon?'COMING SOON':product.stock===0?'OUT OF STOCK':offer)}</em><h3>${storeText(product.name)}</h3><span class="price">${money(product.price)}</span>${product.old?`<span class="old">${money(product.old)}</span>`:''}<button class="add" data-add="${product.id}" ${unavailable?'disabled':''}>${comingSoon?'Coming soon':product.stock===0?'Out of stock':'Add to cart'}</button></div></article>`;
  }).join('');
}
$('#categoryFilters').onclick=event=>{const button=event.target.closest('[data-category]');if(!button)return;$('#categoryFilters').querySelectorAll('button').forEach(item=>{item.classList.toggle('active',item===button);item.setAttribute('aria-pressed',String(item===button))});renderProducts()};
$('#products').onclick=event=>{
  const addId=Number(event.target.dataset.add);
  if(addId){addToCart(addId);return}
  const card=event.target.closest('[data-open]');
  if(card)location.href=`product.html?id=${encodeURIComponent(card.dataset.open)}`;
};
async function loadStorefront(){
  try{
    const response=await fetch('/api/store');
    if(!response.ok)throw Error('Unable to load the product catalogue.');
    const data=await response.json();products=data.products;storeCategories=data.categories;homeContent=data.home;
    document.querySelector('.hero em').textContent=homeContent.season;
    const heroTitle=document.querySelector('.hero h1');heroTitle.textContent=homeContent.title;
    const heroImage=document.querySelector('.heroArt img');heroImage.src=homeContent.image;heroImage.alt=homeContent.title;
    document.querySelector('.hero p').textContent=homeContent.description;
    renderProducts();renderCart();
  }catch(error){toast(error.message)}
}
loadStorefront();
