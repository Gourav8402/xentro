import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(fileURLToPath(import.meta.url));
try{
  const env=await fs.readFile(path.join(root,'.env'),'utf8');
  for(const line of env.split(/\r?\n/)){
    const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(match&&!match[1].startsWith('#')&&!process.env[match[1]])process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
}catch(error){if(error.code!=='ENOENT')throw error}

if(process.env.NODE_ENV==='production'&&(!process.env.ADMIN_ID||!process.env.ADMIN_PASSWORD))throw Error('Set ADMIN_ID and ADMIN_PASSWORD before starting in production.');

const productsFile=path.join(root,'products.json'),contentFile=path.join(root,'site-content.json'),blogPostsFile=path.join(root,'blog-posts.json'),ordersFile=path.join(root,'orders.json'),reviewsFile=path.join(root,'reviews.json'),uploadDir=path.join(root,'uploads');
const adminId=process.env.ADMIN_ID||'xentroadmin1234',adminPassword=process.env.ADMIN_PASSWORD||'xentroadminwebpass@8700';
const shipmentStatuses=['Payment pending','Order confirmed','Paid — processing','Order placed','Ready to ship','Shipped','Out for delivery','Delivered','Cancelled'];
const imageTypes=[{ext:'.png',mime:'image/png',signature:Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])},{ext:'.jpg',mime:'image/jpeg',signature:Buffer.from([0xff,0xd8,0xff])},{ext:'.webp',mime:'image/webp',signature:Buffer.from('RIFF'),format:'WEBP'}];
const sessions=new Map(),loginAttempts=new Map(),reviewAttempts=new Map();
let writeQueue=Promise.resolve(),mutationQueue=Promise.resolve();
function mutate(action){const next=mutationQueue.then(action);mutationQueue=next.catch(()=>{});return next}

async function readArray(file){try{const value=JSON.parse(await fs.readFile(file,'utf8'));if(!Array.isArray(value))throw Error(`${path.basename(file)} must contain a JSON array.`);return value}catch(error){if(error.code==='ENOENT')return [];throw error}}
async function readObject(file,fallback){try{const value=JSON.parse(await fs.readFile(file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${path.basename(file)} must contain a JSON object.`);return value}catch(error){if(error.code==='ENOENT')return structuredClone(fallback);throw error}}
async function writeJson(file,value){const write=async()=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${crypto.randomUUID()}.tmp`;await fs.writeFile(temp,JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx'});await fs.rename(temp,file)};const next=writeQueue.then(write);writeQueue=next.catch(()=>{});return next}
const loadProducts=()=>readArray(productsFile),loadContent=()=>readObject(contentFile,{categories:[],home:{season:'',title:'',description:'',image:'',featuredProductIds:[]}});
const loadOrders=()=>readArray(ordersFile);
const loadReviews=()=>readArray(reviewsFile);
function productReviews(product,reviews){
  const legacy=Array.isArray(product.reviews)?product.reviews:[];
  const approved=reviews.filter(review=>review.productId===product.id&&review.status==='approved');
  const all=[...legacy,...approved].map(review=>({id:review.id||'',name:String(review.name||''),rating:Number(review.rating)||0,text:String(review.text||''),date:review.date||''}));
  const rating=all.length?all.reduce((sum,review)=>sum+review.rating,0)/all.length:Number(product.rating)||0;
  return {...product,rating,reviewCount:all.length||Number(product.reviewCount)||0,reviews:all.slice(0,20)};
}
const json=(res,status,value,extra={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});res.end(JSON.stringify(value))};
const fail=(status,message)=>Object.assign(new Error(message),{status});
async function body(req,max=1024*1024){let raw='',size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw fail(413,'Request is too large.');raw+=chunk}try{return JSON.parse(raw||'{}')}catch{throw fail(400,'Request must contain valid JSON.')}}
const publicOrder=(order,products)=>({id:order.id,createdAt:order.createdAt,status:order.status,trackingId:order.trackingId||'',total:order.total,items:(order.items||[]).map(item=>({name:item.name||products.find(product=>product.id===item.id)?.name||'Item',qty:item.qty}))});
const getTotal=(items,products)=>items.reduce((sum,item)=>sum+products.find(product=>product.id===Number(item.id)).price*Number(item.qty),0);
const validCustomer=customer=>customer&&String(customer.name||'').trim()&&/^[0-9]{10}$/.test(customer.phone)&&String(customer.address||'').trim()&&String(customer.city||'').trim()&&/^[0-9]{6}$/.test(customer.pin);
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const escapeXml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const cleanDescription=value=>String(value??'').replace(/\s+/g,' ').trim();
const metaDescription=value=>{const text=cleanDescription(value);return text.length>157?`${text.slice(0,154).trimEnd()}...`:text};
const jsonLd=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const productUrl=(origin,product)=>`${origin}/product.html?id=${encodeURIComponent(product.id)}`;
const blogUrl=(origin,slug='')=>`${origin}/blog/${slug}`;
const blogPublished=post=>(post.status===undefined||post.status==='published')||(post.status==='scheduled'&&Date.parse(post.scheduledAt)<=Date.now());
const blogPostTitle=post=>String(post.seoTitle||`${post.title} | Xentro Enterprises`).trim().slice(0,70);
const blogPostDescription=post=>String(post.metaDescription||post.description).trim();
function normalizedBlogPost(post){
  const content=post.content||((post.sections||[]).map(section=>[`## ${section.heading}`,...(section.paragraphs||[]),...(section.bullets||[]).map(item=>`- ${item}`)].join('\n\n')).join('\n\n'));
  const status=post.status==='scheduled'&&Date.parse(post.scheduledAt)<=Date.now()?'published':post.status||'published';
  return {...post,content,status,category:post.category||'Guides',seoTitle:post.seoTitle||`${post.title} | Xentro Enterprises`.slice(0,70),metaDescription:post.metaDescription||post.description,focusKeyword:post.focusKeyword||'',canonicalUrl:post.canonicalUrl||'',socialImage:post.socialImage||post.image};
}
function siteSeoMeta(seo){
  const verification=String(seo?.googleSiteVerification||'').trim();
  return verification?`<meta name="google-site-verification" content="${escapeHtml(verification)}">`:'';
}
function absoluteSiteUrl(value,origin,fallback){
  if(!value)return fallback;
  try{const parsed=new URL(value);return ['http:','https:'].includes(parsed.protocol)?parsed.href:fallback}catch{return fallback}
}
const absoluteImageUrl=(value,origin)=>/^https?:\/\//i.test(value)?value:`${origin}/${value}`;
function requestOrigin(req){
  const host=req.headers.host||'localhost',forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim().toLowerCase(),remote=req.socket.remoteAddress||'';
  const localProxy=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote),quickTunnel=/\.trycloudflare\.com(?::\d+)?$/i.test(host);
  const protocol=quickTunnel?'https':localProxy&&['http','https'].includes(forwarded)?forwarded:req.socket.encrypted?'https':'http';
  return `${protocol}://${host}`;
}
function productSchema(product,origin){
  const images=Array.isArray(product.images)&&product.images.length?product.images:[product.img];
  const url=absoluteSiteUrl(product.canonicalUrl,origin,productUrl(origin,product));
  return {'@context':'https://schema.org','@type':'Product',name:product.name,description:cleanDescription(product.metaDescription||product.description),image:images.map(image=>absoluteImageUrl(image,origin)),keywords:product.focusKeyword||undefined,category:product.category,url,brand:{'@type':'Brand',name:'Xentro Enterprises'},offers:{'@type':'Offer',url,priceCurrency:'INR',price:String(product.price),availability:product.active===false?'https://schema.org/PreOrder':product.stock===0?'https://schema.org/OutOfStock':'https://schema.org/InStock',itemCondition:'https://schema.org/NewCondition'}};
}
function renderProductBody(product){
  const comingSoon=product.active===false,name=escapeHtml(product.name),description=escapeHtml(product.description),images=Array.isArray(product.images)&&product.images.length?product.images:[product.img],imageAlt=escapeHtml(product.imageAlt||product.name),tag=escapeHtml(comingSoon?'COMING SOON':product.stock===0?'OUT OF STOCK':product.offerText||product.tag||'');
  const old=Number(product.old)||0,discount=old?Math.round((1-Number(product.price)/old)*100):0,unavailable=comingSoon||product.stock===0;
  const features=(product.features||[]).map(feature=>`<li>${escapeHtml(feature)}</li>`).join('');
  const specs=Object.entries(product.specs||{}).map(([key,value])=>`<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
  const stock=comingSoon?'Coming soon':product.stock===0?'Out of stock':product.stock===null||product.stock===undefined?'In stock':`${escapeHtml(product.stock)} in stock`;
  const gallery=`<div class="pdp-gallery"><img id="productMainImage" src="${escapeHtml(images[0])}" alt="${imageAlt}">${images.length>1?`<div class="product-thumbnails" role="group" aria-label="Product images">${images.map((image,index)=>`<button class="product-thumbnail${index===0?' active':''}" type="button" data-gallery-image="${index}" aria-label="View image ${index+1} of ${name}" aria-pressed="${index===0}"><img src="${escapeHtml(image)}" alt="" loading="lazy"></button>`).join('')}</div>`:''}</div>`;
  return `${gallery}<div class="pdp-info"><em class="tag">${tag}</em><h1>${name}</h1><div class="rating-line"><span>${Number(product.rating||0).toFixed(1)} · ${Number(product.reviewCount||0)} reviews</span></div><div class="price-line"><span class="price">₹${Number(product.price).toLocaleString('en-IN')}</span>${old?`<span class="old">₹${old.toLocaleString('en-IN')}</span><span class="off">${discount}% off</span>`:''}</div><p class="desc">${description}</p><p class="stock-message${unavailable?' stock-unavailable':''}" id="productStock">${stock}</p><div class="qty-row"><label for="qty">Qty</label><div class="quantity"><button type="button" id="qtyMinus" aria-label="Decrease quantity"${unavailable?' disabled':''}>−</button><span id="qtyVal">1</span><button type="button" id="qtyPlus" aria-label="Increase quantity"${unavailable?' disabled':''}>+</button></div></div><div class="pdp-actions"><button class="primary wide" id="pdpAdd"${unavailable?' disabled':''}>${comingSoon?'Coming soon':unavailable?'Out of stock':'Add to cart'}</button><button class="secondary wide" id="pdpBuy"${unavailable?' disabled':''}>${comingSoon?'Coming soon':'Buy now'}</button></div>${features?`<ul class="features">${features}</ul>`:''}${specs?`<table class="specs"><tbody>${specs}</tbody></table>`:''}</div>`;
}
function blogImage(post,origin,image=post.image){return /^https?:\/\//i.test(image)?image:`${origin}/${image}`}
function blogSchema(posts,origin){
  return {'@context':'https://schema.org','@type':'Blog',name:'Xentro School Bag Guides',url:blogUrl(origin),blogPost:posts.map(post=>({'@type':'BlogPosting',headline:post.title,url:blogUrl(origin,post.slug),description:blogPostDescription(post),datePublished:post.publishedAt,image:blogImage(post,origin,post.socialImage||post.image),author:{'@type':'Organization',name:'Xentro Enterprises'}}))};
}
function blogPostSchema(post,origin){
  const url=blogUrl(origin,post.slug);
  return {'@context':'https://schema.org','@type':'BlogPosting',headline:blogPostTitle(post),description:blogPostDescription(post),image:[blogImage(post,origin,post.socialImage||post.image)],datePublished:post.publishedAt,dateModified:post.updatedAt||post.publishedAt,mainEntityOfPage:{'@type':'WebPage','@id':post.canonicalUrl||url},keywords:post.focusKeyword||undefined,articleSection:post.category||'Guides',author:{'@type':'Organization',name:'Xentro Enterprises',url:`${origin}/`},publisher:{'@type':'Organization',name:'Xentro Enterprises',logo:{'@type':'ImageObject',url:`${origin}/assets/logo.png`}}};
}
function blogContentHtml(post){
  if(!post.content)return (post.sections||[]).map(section=>`<section class="blog-copy"><h2>${escapeHtml(section.heading)}</h2>${(section.paragraphs||[]).map(paragraph=>`<p>${escapeHtml(paragraph)}</p>`).join('')}${section.bullets?.length?`<ul>${section.bullets.map(item=>`<li>${escapeHtml(item)}</li>`).join('')}</ul>`:''}</section>`).join('');
  const blocks=[],paragraph=[],lines=post.content.split(/\r?\n/);
  const flushParagraph=()=>{if(paragraph.length){blocks.push(`<p>${escapeHtml(paragraph.join(' '))}</p>`);paragraph.length=0}};
  for(let index=0;index<lines.length;index++){
    const line=lines[index].trim();
    if(!line){flushParagraph();continue}
    const heading=line.match(/^(#{2,3})\s+(.+)$/);
    if(heading){flushParagraph();const level=heading[1].length;blocks.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);continue}
    if(line.startsWith('- ')){flushParagraph();const items=[];while(index<lines.length&&lines[index].trim().startsWith('- ')){items.push(`<li>${escapeHtml(lines[index].trim().slice(2))}</li>`);index++}index--;blocks.push(`<ul>${items.join('')}</ul>`);continue}
    paragraph.push(line);
  }
  flushParagraph();
  return `<section class="blog-copy">${blocks.join('')}</section>`;
}
function blogCard(post,origin){
  const publishedAt=post.publishedAt||new Date().toISOString().slice(0,10);
  return `<article class="blog-card"><a href="${escapeHtml(blogUrl(origin,post.slug))}"><img src="${escapeHtml(blogImage(post,origin,post.socialImage||post.image))}" alt="${escapeHtml(post.imageAlt||post.title)}" loading="lazy"></a><div class="blog-card-content"><span class="blog-category">${escapeHtml(post.category||'Guides')}</span><time class="blog-date" datetime="${escapeHtml(publishedAt)}">${escapeHtml(new Date(`${publishedAt}T12:00:00Z`).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}))}</time><h2><a href="${escapeHtml(blogUrl(origin,post.slug))}">${escapeHtml(post.title)}</a></h2><p>${escapeHtml(blogPostDescription(post))}</p><a class="blog-read" href="${escapeHtml(blogUrl(origin,post.slug))}">Read the guide →</a></div></article>`;
}
function blogArticle(post,origin,products,posts){
  const relatedProduct=products.find(product=>product.id===post.relatedProductId&&product.active!==false);
  const relatedPosts=posts.filter(item=>item.slug!==post.slug).slice(0,2);
  const relatedLinks=relatedPosts.map(item=>`<a href="${escapeHtml(blogUrl(origin,item.slug))}">${escapeHtml(item.title)}</a>`).join(' · ');
  const cta=relatedProduct?`<aside class="blog-cta"><strong>Looking for a bag for everyday school use?</strong><p>Review the product details, dimensions, and features before choosing.</p><a class="primary" href="${escapeHtml(productUrl(origin,relatedProduct))}">View ${escapeHtml(relatedProduct.name)} →</a></aside>`:'';
  const publishedAt=post.publishedAt||new Date().toISOString().slice(0,10);
  return `<article class="blog-article"><p class="blog-breadcrumb"><a href="/">Home</a> / <a href="/blog/">Blog</a> / ${escapeHtml(post.title)}</p><span class="blog-category">${escapeHtml(post.category||'Guides')}</span><time class="article-meta" datetime="${escapeHtml(publishedAt)}">${escapeHtml(new Date(`${publishedAt}T12:00:00Z`).toLocaleDateString('en-IN',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}))} · Xentro Enterprises</time><h1>${escapeHtml(post.title)}</h1><p class="article-lead">${escapeHtml(post.description)}</p><img class="blog-cover" src="${escapeHtml(blogImage(post,origin,post.image))}" alt="${escapeHtml(post.imageAlt||post.title)}">${blogContentHtml(post)}${cta}${relatedLinks?`<nav class="blog-related" aria-label="Related guides"><strong>More school bag guides</strong><p>${relatedLinks}</p></nav>`:''}</article>`;
}
function renderBlogPage(template,post,posts,products,origin,seo={}){
  const isIndex=!post,canonical=isIndex?absoluteSiteUrl(seo.blogCanonical,origin,blogUrl(origin)):absoluteSiteUrl(post.canonicalUrl,origin,blogUrl(origin,post.slug));
  const title=isIndex?(seo.blogTitle||'School Bag Guides & Care Tips | Xentro Enterprises'):blogPostTitle(post);
  const description=cleanDescription(isIndex?(seo.blogDescription||'Practical school backpack guides, packing checklists, and care tips from Xentro Enterprises.'):blogPostDescription(post)).slice(0,320),image=isIndex?absoluteImageUrl(seo.blogSocialImage||'assets/hero-bag.png',origin):blogImage(post,origin,post.socialImage||post.image);
  const structuredData=isIndex?blogSchema(posts,origin):blogPostSchema(post,origin);
  const articleContent=isIndex?`<section class="blog-hero"><em>XENTRO JOURNAL</em><h1>${escapeHtml(seo.blogHeading||'School bag guides for everyday life')}</h1><p>${escapeHtml(seo.blogIntro||'Practical advice on choosing a backpack, packing for school, and caring for everyday essentials.')}</p></section><section class="blog-grid" aria-label="Blog articles">${posts.map(item=>blogCard(item,origin)).join('')}</section>`:blogArticle(post,origin,products,posts);
  const head=`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#071a33">${siteSeoMeta(seo)}<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="${isIndex?'website':'article'}"><meta property="og:site_name" content="Xentro Enterprises"><meta property="og:locale" content="en_IN"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:alt" content="${escapeHtml(isIndex?'School bags and care guides':post.imageAlt||post.title)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(image)}"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/blog.css"><script type="application/ld+json">${jsonLd(structuredData)}</script></head>`;
  return template.replace(/<head>[\s\S]*?<\/head>/,head).replace('{{BLOG_CONTENT}}',articleContent);
}
async function validateImagePath(image){
  if(!/^(assets|uploads)\/[A-Za-z0-9._/-]+$/.test(image)||image.includes('..'))throw fail(400,'Choose a valid image.');
  const file=path.resolve(root,image),relative=path.relative(root,file);
  if(relative.startsWith('..')||!['.png','.jpg','.jpeg','.webp'].includes(path.extname(file).toLowerCase()))throw fail(400,'Choose a valid image.');
  try{if(!(await fs.stat(file)).isFile())throw fail(400,'Choose a valid image.')}catch(error){if(error.status)throw error;if(error.code==='ENOENT')throw fail(400,'Choose an image file that exists.');throw error}
}
function validateProduct(input,products,existingId=null){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Product details are required.');
  const name=String(input.name||'').trim(),description=String(input.description||'').trim(),price=Number(input.price),old=Number(input.old||0),stock=input.stock===''||input.stock===null||input.stock===undefined?null:Number(input.stock),category=String(input.category||'').trim(),tag=String(input.tag||'').trim(),rawImages=Array.isArray(input.images)?input.images:[input.img],images=rawImages.map(image=>String(image||'').trim()),seoTitle=String(input.seoTitle||'').trim(),metaDescriptionValue=String(input.metaDescription||'').trim(),focusKeyword=String(input.focusKeyword||'').trim(),canonicalUrl=String(input.canonicalUrl||'').trim(),imageAlt=String(input.imageAlt||name).trim(),socialImage=String(input.socialImage||images[0]||'').trim();
  if(!name||name.length>140||!description||description.length>10000)throw fail(400,'Enter a product name and description within the allowed length.');
  if(!Number.isFinite(price)||price<0||price>10000000||!Number.isFinite(old)||old<0||old>10000000)throw fail(400,'Enter valid product prices.');
  if(stock!==null&&(!Number.isSafeInteger(stock)||stock<0||stock>1000000))throw fail(400,'Stock must be a whole number from 0 to 1,000,000.');
  if(!category||category.length>60||!tag||tag.length>40)throw fail(400,'Enter a category and product label.');
  if(!images.length||images.length>10||images.some(image=>!image||!/^(assets|uploads)\/[A-Za-z0-9._/-]+$/.test(image)||image.includes('..'))||new Set(images).size!==images.length)throw fail(400,'Add 1 to 10 distinct, valid product images.');
  if(seoTitle.length>70||metaDescriptionValue.length>320||focusKeyword.length>120||imageAlt.length>250)throw fail(400,'Product SEO title must be 70 characters or fewer, description 320, keyword 120, and image alt text 250.');
  if(!/^(assets|uploads)\/[A-Za-z0-9._/-]+$/.test(socialImage)||socialImage.includes('..'))throw fail(400,'Choose a valid product social sharing image.');
  if(canonicalUrl){let canonical;try{canonical=new URL(canonicalUrl)}catch{throw fail(400,'Canonical URL must be a complete http or https URL.')}if(!['http:','https:'].includes(canonical.protocol)||canonical.username||canonical.password||canonicalUrl.length>500)throw fail(400,'Canonical URL must be a complete http or https URL without credentials.')}
  const duplicate=products.some(product=>product.id!==existingId&&product.name.toLowerCase()===name.toLowerCase());
  if(duplicate)throw fail(409,'A product with that name already exists.');
  const features=Array.isArray(input.features)?input.features.map(item=>String(item).trim()).filter(Boolean).slice(0,40):[];
  const specs=input.specs&&typeof input.specs==='object'&&!Array.isArray(input.specs)?Object.fromEntries(Object.entries(input.specs).slice(0,50).map(([key,value])=>[String(key).slice(0,80),String(value).slice(0,300)])):{};
  const reviews=Array.isArray(input.reviews)?input.reviews.slice(0,100):[];
  return {name,description,price,old,img:images[0],images,seoTitle:seoTitle||`${name} | Xentro Enterprises`.slice(0,70),metaDescription:metaDescriptionValue||cleanDescription(description).slice(0,320),focusKeyword,canonicalUrl,imageAlt,socialImage,tag,category,stock,featured:Boolean(input.featured),active:input.active!==false,offerText:String(input.offerText||'').trim().slice(0,80),rating:Number(input.rating)||0,reviewCount:Number(input.reviewCount)||0,features,specs,reviews};
}
function validateBlogPost(input,posts,existingSlug=null){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail(400,'Blog post details are required.');
  const slug=String(input.slug||'').trim(),title=String(input.title||'').trim(),description=String(input.description||'').trim(),category=String(input.category||'').trim(),image=String(input.image||'').trim(),imageAlt=String(input.imageAlt||'').trim(),content=String(input.content||'').trim(),seoTitle=String(input.seoTitle||'').trim(),metaDescriptionValue=String(input.metaDescription||'').trim(),focusKeyword=String(input.focusKeyword||'').trim(),canonicalUrl=String(input.canonicalUrl||'').trim(),socialImage=String(input.socialImage||image).trim(),status=String(input.status||'draft'),publishedAt=String(input.publishedAt||new Date().toISOString().slice(0,10)),scheduledAt=String(input.scheduledAt||'');
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||slug.length>100)throw fail(400,'Use a lowercase URL slug with letters, numbers, and single hyphens only.');
  if(!title||title.length>180||!description||description.length>320||!category||category.length>80||!imageAlt||imageAlt.length>250||!content||content.length>50000)throw fail(400,'Complete the blog title, description, category, image alt text, and content within the allowed lengths.');
  if(seoTitle.length>70||metaDescriptionValue.length>320||focusKeyword.length>120)throw fail(400,'SEO title must be 70 characters or fewer, description 320, and focus keyword 120.');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)||Number.isNaN(Date.parse(`${publishedAt}T00:00:00Z`))||new Date(`${publishedAt}T00:00:00Z`).toISOString().slice(0,10)!==publishedAt)throw fail(400,'Enter a valid publication date.');
  if(!['draft','published','scheduled'].includes(status))throw fail(400,'Choose draft, published, or scheduled status.');
  if(status==='scheduled'&&(!scheduledAt||!Number.isFinite(Date.parse(scheduledAt))||Date.parse(scheduledAt)<=Date.now()))throw fail(400,'Choose a future publication time to schedule this post.');
  if(canonicalUrl){let canonical;try{canonical=new URL(canonicalUrl)}catch{throw fail(400,'Canonical URL must be a complete http or https URL.')}if(!['http:','https:'].includes(canonical.protocol)||canonical.username||canonical.password||canonicalUrl.length>500)throw fail(400,'Canonical URL must be a complete http or https URL without credentials.')}
  if(!/^(assets|uploads)\/[A-Za-z0-9._/-]+$/.test(image)||image.includes('..')||! /^(assets|uploads)\/[A-Za-z0-9._/-]+$/.test(socialImage)||socialImage.includes('..'))throw fail(400,'Choose valid uploaded images for the post and social share preview.');
  const collision=posts.some(post=>post.slug!==existingSlug&&(post.slug===slug||(post.previousSlugs||[]).includes(slug)));
  if(collision)throw fail(409,'That URL slug is already in use.');
  return {slug,title,description,category,image,imageAlt,content,seoTitle:seoTitle||`${title} | Xentro Enterprises`.slice(0,70),metaDescription:metaDescriptionValue||description,focusKeyword,canonicalUrl,socialImage,status,publishedAt:status==='scheduled'?scheduledAt.slice(0,10):publishedAt,scheduledAt:status==='scheduled'?new Date(scheduledAt).toISOString():'',updatedAt:new Date().toISOString(),...(Number.isSafeInteger(Number(input.relatedProductId))&&Number(input.relatedProductId)>0?{relatedProductId:Number(input.relatedProductId)}:{})};
}
function adminSession(req){const token=(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('xentro_admin='))?.slice('xentro_admin='.length);const session=sessions.get(token);if(!session||session.expires<Date.now()){if(token)sessions.delete(token);return false}session.expires=Date.now()+8*60*60*1000;return true}
function sameOrigin(req){const origin=req.headers.origin;if(!origin)return;try{if(new URL(origin).host!==req.headers.host)throw fail(403,'Request origin is not allowed.')}catch(error){if(error.status)throw error;throw fail(403,'Request origin is not allowed.')}}
async function staticFile(url,res){
  if(url.pathname==='/reviews'||url.pathname==='/reviews/'){
    const [contents,content]=await Promise.all([fs.readFile(path.join(root,'reviews.html'),'utf8'),loadContent()]),seo=content.seo||{},title=seo.reviewsTitle||'Customer Reviews | Xentro Enterprises',description=cleanDescription(seo.reviewsDescription||'Read and share customer reviews for Xentro products, including feedback on upcoming launches.').slice(0,320),canonical=absoluteSiteUrl(seo.reviewsCanonical,url.origin,`${url.origin}/reviews/`),image=seo.reviewsSocialImage?absoluteImageUrl(seo.reviewsSocialImage,url.origin):'';
    const head=`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#071a33">${siteSeoMeta(seo)}<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:site_name" content="Xentro Enterprises"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}">${image?`<meta property="og:image" content="${escapeHtml(image)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${escapeHtml(image)}">`:''}<meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css?v=professional-footer-20261024"><link rel="stylesheet" href="/reviews.css"></head>`;
    const html=contents.toString('utf8').replace(/<head>[\s\S]*?<\/head>/,head);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return res.end(html)
  }
  if(url.pathname==='/blog'||url.pathname==='/blog/'||url.pathname.startsWith('/blog/')){
    const articleMatch=url.pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/),allPosts=(await readArray(blogPostsFile)).map(normalizedBlogPost),posts=allPosts.filter(blogPublished),content=await loadContent(),seo=content.seo||{};
    if(url.pathname!=='/blog'&&url.pathname!=='/blog/'&&!articleMatch)throw fail(404,'Blog page not found.');
    const post=articleMatch?posts.find(item=>item.slug===articleMatch[1]):null;
    if(articleMatch&&!post){
      const previous=allPosts.find(item=>(item.previousSlugs||[]).includes(articleMatch[1])&&blogPublished(item));
      if(previous){res.writeHead(301,{Location:blogUrl(url.origin,previous.slug),'Cache-Control':'no-cache'});return res.end()}
    }
    if(articleMatch&&!post)throw fail(404,'Blog article not found.');
    const template=await fs.readFile(path.join(root,'blog.html'),'utf8'),products=post?await loadProducts():[];
    const html=renderBlogPage(template,post,posts,products,url.origin,seo);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});return res.end(html)
  }
  let relative;try{relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1))}catch{throw fail(400,'Invalid URL path.')}
  if(relative.startsWith('.')||relative.includes('\\')||relative.split('/').some(part=>part==='..'))throw fail(404,'Not found.');
  const file=path.resolve(root,relative),rel=path.relative(root,file);
  if(rel.startsWith('..')||path.isAbsolute(rel))throw fail(404,'Not found.');
  const ext=path.extname(file).toLowerCase(),allowed=new Set(['.html','.js','.css','.png','.jpeg','.jpg','.webp','.svg','.ico']);
  if(!allowed.has(ext)||relative==='server.js')throw fail(404,'Not found.');
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpeg':'image/jpeg','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon'}[ext];
  let contents;try{contents=await fs.readFile(file)}catch(error){if(error.code==='ENOENT')throw fail(404,'Not found.');throw error}
  if(relative==='index.html'){
    const origin=url.origin,[allProducts,content]=await Promise.all([loadProducts(),loadContent()]);
    const products=allProducts.filter(product=>product.active!==false);
    const structuredData={'@context':'https://schema.org','@graph':[
      {'@type':'Organization',name:'Xentro Enterprises',url:`${origin}/`,logo:`${origin}/assets/logo.png`,email:'xentroenterprises@gmail.com'},
      {'@type':'WebSite',name:'Xentro Enterprises',url:`${origin}/`},
      {'@type':'ItemList',name:'Xentro school essentials',itemListElement:products.map((product,index)=>({'@type':'ListItem',position:index+1,url:absoluteSiteUrl(product.canonicalUrl,origin,productUrl(origin,product)),item:{'@type':'Product',name:product.name,image:(Array.isArray(product.images)&&product.images.length?product.images:[product.img]).map(image=>absoluteImageUrl(image,origin)),description:cleanDescription(product.metaDescription||product.description),offers:{'@type':'Offer',url:absoluteSiteUrl(product.canonicalUrl,origin,productUrl(origin,product)),priceCurrency:'INR',price:String(product.price),availability:product.stock===0?'https://schema.org/OutOfStock':'https://schema.org/InStock'}}}))}
    ]};
    const seo=content.seo||{},title=seo.homeTitle||`${cleanDescription(content.home?.title)||'School Bags & Accessories'} | Xentro Enterprises`;
    const description=cleanDescription(seo.homeDescription||content.home?.description||'Shop school bags and accessories from Xentro Enterprises. Explore product details, prices, and delivery information.').slice(0,320);
    const image=absoluteImageUrl(seo.homeSocialImage||content.home?.image||'assets/hero-bag.png',origin);
    const canonical=absoluteSiteUrl(seo.homeCanonical,origin,`${origin}/`);
    const head=`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="index,follow,max-image-preview:large"><meta name="theme-color" content="#071a33">${siteSeoMeta(seo)}<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:site_name" content="Xentro Enterprises"><meta property="og:locale" content="en_IN"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:alt" content="Xentro school bags and accessories"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(image)}"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css?v=professional-footer-20261024"><script type="application/ld+json">${jsonLd(structuredData)}</script></head>`;
    const html=contents.toString('utf8').replace(/<head>[\s\S]*?<\/head>/,head).replace('<html lang="en">','<html lang="en-IN">');
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});return res.end(html)
  }
  if(relative==='product.html'){
    const id=url.searchParams.get('id'),allProducts=await loadProducts(),product=allProducts.find(entry=>String(entry.id)===id);
    if(!product)throw fail(404,'Product not found.');
    const content=await loadContent(),seo=content.seo||{},origin=url.origin,canonical=absoluteSiteUrl(product.canonicalUrl,origin,productUrl(origin,product)),title=product.seoTitle||`${cleanDescription(product.name)} | Xentro Enterprises`,description=cleanDescription(product.metaDescription||product.description).slice(0,320),image=absoluteImageUrl(product.socialImage||product.img,origin),imageAlt=product.imageAlt||product.name,robots=product.active===false?'noindex,follow':'index,follow,max-image-preview:large';
    const structuredData=productSchema(product,origin);
    const head=`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="${robots}"><meta name="theme-color" content="#071a33">${siteSeoMeta(seo)}<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="product"><meta property="og:site_name" content="Xentro Enterprises"><meta property="og:locale" content="en_IN"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(image)}"><meta property="og:image:alt" content="${escapeHtml(imageAlt)}"><meta property="product:price:amount" content="${escapeHtml(product.price)}"><meta property="product:price:currency" content="INR"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(image)}"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/style.css?v=professional-footer-20261024"><link rel="stylesheet" href="product.css"><script type="application/ld+json">${jsonLd(structuredData)}</script></head>`;
    const html=contents.toString('utf8').replace(/<head>[\s\S]*?<\/head>/,head).replace('<html lang="en">','<html lang="en-IN">').replace('<span id="crumbName">Product</span>',`<span id="crumbName">${escapeHtml(product.name)}</span>`).replace('<section class="pdp reveal" id="pdp"></section>',`<section class="pdp reveal" id="pdp">${renderProductBody(product)}</section>`);
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-cache'});return res.end(html)
  }
  const cacheControl=['.html','.js','.css'].includes(ext)?'no-cache':'public, max-age=300';
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':cacheControl});res.end(contents)
}
function loginLimiter(req){const key=req.socket.remoteAddress||'unknown',entry=loginAttempts.get(key)||{count:0,until:0};if(entry.until>Date.now()&&entry.count>=10)throw fail(429,'Too many login attempts. Try again in 15 minutes.');if(entry.until<Date.now())entry.count=0;return key}
function safeEqual(a,b){const left=Buffer.from(String(a)),right=Buffer.from(String(b));return left.length===right.length&&crypto.timingSafeEqual(left,right)}
async function stats(){const [products,orders]=await Promise.all([loadProducts(),loadOrders()]);return {products:products.length,activeProducts:products.filter(product=>product.active!==false).length,outOfStock:products.filter(product=>product.stock===0).length,trackedStock:products.reduce((sum,product)=>sum+(Number(product.stock)||0),0),orders:orders.length,pendingOrders:orders.filter(order=>!['Delivered','Cancelled'].includes(order.status)).length,sales:orders.filter(order=>['Paid — processing','Order placed','Ready to ship','Shipped','Out for delivery','Delivered'].includes(order.status)).reduce((sum,order)=>sum+Number(order.total||0),0)}}
async function uploadImage(data){if(typeof data!=='string')throw fail(400,'Select a PNG, JPEG, or WebP image.');const match=data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/);if(!match)throw fail(400,'Select a valid PNG, JPEG, or WebP image.');const buffer=Buffer.from(match[2],'base64');if(!buffer.length||buffer.length>5*1024*1024)throw fail(413,'Image must be smaller than 5 MB.');const type=imageTypes.find(item=>item.mime===match[1]&&buffer.subarray(0,item.signature.length).equals(item.signature)&&(!item.format||buffer.subarray(8,12).toString()===item.format));if(!type)throw fail(400,'Image contents do not match the selected image type.');const filename=`${crypto.randomUUID()}${type.ext}`;await fs.mkdir(uploadDir,{recursive:true});await fs.writeFile(path.join(uploadDir,filename),buffer,{flag:'wx'});return `uploads/${filename}`}

http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,requestOrigin(req)),method=req.method;
    if(method==='GET'&&url.pathname==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'public, max-age=3600'});return res.end(`User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /api/\nSitemap: ${url.origin}/sitemap.xml\n`)}
    if(method==='GET'&&url.pathname==='/sitemap.xml'){
      const [allProducts,storedPosts,content]=await Promise.all([loadProducts(),readArray(blogPostsFile),loadContent()]),products=allProducts.filter(product=>product.active!==false),posts=storedPosts.map(normalizedBlogPost).filter(blogPublished);
      const canonicalLocation=value=>{if(!value)return null;try{const parsed=new URL(value,url.origin);return parsed.origin===url.origin?parsed.href:null}catch{return null}};
      const blogIndexLocation=content.seo?.blogCanonical?canonicalLocation(content.seo.blogCanonical):blogUrl(url.origin),reviewsLocation=content.seo?.reviewsCanonical?canonicalLocation(content.seo.reviewsCanonical):`${url.origin}/reviews/`;
      const productLocations=products.map(product=>product.canonicalUrl?canonicalLocation(product.canonicalUrl):productUrl(url.origin,product)).filter(Boolean),postLocations=posts.map(post=>post.canonicalUrl?canonicalLocation(post.canonicalUrl):blogUrl(url.origin,post.slug)).filter(Boolean);
      const homeLocation=content.seo?.homeCanonical?canonicalLocation(content.seo.homeCanonical):`${url.origin}/`;
      const locations=[...(homeLocation?[homeLocation]:[]),...productLocations,...(reviewsLocation?[reviewsLocation]:[]),...(blogIndexLocation?[blogIndexLocation]:[]),...postLocations];
      const xml=`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations.map(location=>`<url><loc>${escapeXml(location)}</loc></url>`).join('')}</urlset>`;
      res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-cache'});return res.end(xml)
    }
    if(method==='GET'&&url.pathname==='/api/store'){
      const [products,content,reviews]=await Promise.all([loadProducts(),loadContent(),loadReviews()]);
      return json(res,200,{products:products.map(product=>productReviews(product,reviews)),categories:content.categories||[],home:content.home||{}});
    }
    if(method==='POST'&&url.pathname==='/api/reviews')return await mutate(async()=>{
      sameOrigin(req);
      const input=await body(req,4096),name=String(input.name||'').trim(),text=String(input.text||'').trim(),rating=Number(input.rating),productId=Number(input.productId);
      if(!Number.isSafeInteger(productId)||!name||name.length>80||!text||text.length>1200||!Number.isInteger(rating)||rating<1||rating>5)throw fail(400,'Enter your name, a rating from 1 to 5, and a review of up to 1,200 characters.');
      const products=await loadProducts();
      if(!products.some(product=>product.id===productId))throw fail(404,'This product is no longer available for reviews.');
      const key=req.socket.remoteAddress||'unknown',now=Date.now(),recent=(reviewAttempts.get(key)||[]).filter(time=>now-time<60*60*1000);
      if(recent.length>=5)throw fail(429,'Too many reviews have been submitted from your connection. Please try again later.');
      recent.push(now);reviewAttempts.set(key,recent);
      const reviews=await loadReviews(),review={id:crypto.randomUUID(),productId,name,rating,text,date:new Date().toISOString(),status:'pending'};
      reviews.unshift(review);await writeJson(reviewsFile,reviews);
      return json(res,201,{ok:true,message:'Thank you. Your review has been sent for approval.'});
    });
    if(method==='POST'&&url.pathname==='/api/admin/login'){
      const key=loginLimiter(req),attempt=loginAttempts.get(key)||{count:0,until:0},credentials=await body(req);
      if(!safeEqual(credentials.adminId,adminId)||!safeEqual(credentials.password,adminPassword)){attempt.count++;attempt.until=Date.now()+15*60*1000;loginAttempts.set(key,attempt);return json(res,401,{error:'Incorrect administrator ID or password.'})}
      loginAttempts.delete(key);const token=crypto.randomBytes(32).toString('base64url');sessions.set(token,{expires:Date.now()+8*60*60*1000});
      return json(res,200,{ok:true},{'Set-Cookie':`xentro_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${url.protocol==='https:'?'; Secure':''}`});
    }
    if(method==='POST'&&url.pathname==='/api/admin/logout'){
      sameOrigin(req);const token=(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('xentro_admin='))?.slice('xentro_admin='.length);if(token)sessions.delete(token);
      return json(res,200,{ok:true},{'Set-Cookie':'xentro_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    }
    const adminPath=url.pathname.startsWith('/api/admin/');
    if(adminPath&&!adminSession(req))return json(res,401,{error:'Your admin session expired. Sign in again.'});
    if(adminPath&&['POST','PUT','PATCH','DELETE'].includes(method))sameOrigin(req);

    if(adminPath&&method==='GET'&&url.pathname==='/api/admin/dashboard')return json(res,200,await stats());
    if(adminPath&&method==='GET'&&url.pathname==='/api/admin/products')return json(res,200,await loadProducts());
    if(adminPath&&method==='GET'&&url.pathname==='/api/admin/blog')return json(res,200,(await readArray(blogPostsFile)).map(normalizedBlogPost));
    if(adminPath&&method==='GET'&&url.pathname==='/api/admin/seo'){const content=await loadContent();return json(res,200,content.seo||{})}
    if(adminPath&&method==='PUT'&&url.pathname==='/api/admin/seo')return await mutate(async()=>{
      const input=await body(req),content=await loadContent(),seo={};
      for(const [key,max] of Object.entries({homeTitle:70,blogTitle:70,reviewsTitle:70,homeDescription:320,blogDescription:320,reviewsDescription:320,blogHeading:160,blogIntro:320,googleSiteVerification:200,homeSocialImage:200,blogSocialImage:200,reviewsSocialImage:200})){
        const value=String(input[key]??'').trim();if(value.length>max)throw fail(400,`${key} must be ${max} characters or fewer.`);seo[key]=value
      }
      for(const key of ['homeCanonical','blogCanonical','reviewsCanonical']){
        const value=String(input[key]||'').trim();if(value){let parsed;try{parsed=new URL(value)}catch{throw fail(400,`${key} must be a complete http or https URL.`)}if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||value.length>500)throw fail(400,`${key} must be a complete http or https URL without credentials.`)}seo[key]=value
      }
      if(seo.googleSiteVerification&&!/^[A-Za-z0-9_-]+$/.test(seo.googleSiteVerification))throw fail(400,'Google verification code must contain letters, numbers, underscores, or hyphens only.');
      await Promise.all(['homeSocialImage','blogSocialImage','reviewsSocialImage'].filter(key=>seo[key]).map(key=>validateImagePath(seo[key])));
      content.seo=seo;await writeJson(contentFile,content);return json(res,200,seo)
    });
    if(adminPath&&method==='GET'&&url.pathname==='/api/admin/reviews'){
      const [reviews,products]=await Promise.all([loadReviews(),loadProducts()]);
      return json(res,200,reviews.map(review=>({...review,productName:products.find(product=>product.id===review.productId)?.name||'Deleted product'})))
    }
    const adminReviewMatch=url.pathname.match(/^\/api\/admin\/reviews\/([^/]+)$/);
    if(adminPath&&adminReviewMatch&&['PATCH','DELETE'].includes(method))return await mutate(async()=>{
      const reviews=await loadReviews(),index=reviews.findIndex(review=>review.id===adminReviewMatch[1]);
      if(index<0)throw fail(404,'Review not found.');
      if(method==='DELETE'){reviews.splice(index,1);await writeJson(reviewsFile,reviews);return json(res,200,{ok:true})}
      const update=await body(req);
      if(!['approved','rejected'].includes(update.status))throw fail(400,'Choose approve or reject for this review.');
      reviews[index].status=update.status;reviews[index].updatedAt=new Date().toISOString();
      await writeJson(reviewsFile,reviews);return json(res,200,reviews[index])
    });
    if(adminPath&&method==='POST'&&url.pathname==='/api/admin/blog')return await mutate(async()=>{
      const posts=await readArray(blogPostsFile),post=validateBlogPost(await body(req,300000),posts);await Promise.all([validateImagePath(post.image),validateImagePath(post.socialImage)]);
      posts.push(post);await writeJson(blogPostsFile,posts);return json(res,201,normalizedBlogPost(post))
    });
    const blogAdminMatch=url.pathname.match(/^\/api\/admin\/blog\/([a-z0-9-]+)$/);
    if(adminPath&&blogAdminMatch&&['PUT','PATCH','DELETE'].includes(method))return await mutate(async()=>{
      const posts=await readArray(blogPostsFile),slug=blogAdminMatch[1],index=posts.findIndex(post=>post.slug===slug);
      if(index<0)throw fail(404,'Blog post not found.');
      if(method==='DELETE'){posts.splice(index,1);await writeJson(blogPostsFile,posts);return json(res,200,{ok:true})}
      if(method==='PATCH'){
        const update=await body(req);if(!['draft','published'].includes(update.status))throw fail(400,'Choose publish or unpublish for this post.');
        posts[index]={...normalizedBlogPost(posts[index]),status:update.status,scheduledAt:'',updatedAt:new Date().toISOString(),publishedAt:update.status==='published'&&posts[index].status!=='published'?new Date().toISOString().slice(0,10):posts[index].publishedAt};
        await writeJson(blogPostsFile,posts);return json(res,200,normalizedBlogPost(posts[index]))
      }
      const update=validateBlogPost(await body(req,300000),posts,slug);await Promise.all([validateImagePath(update.image),validateImagePath(update.socialImage)]);
      const old=normalizedBlogPost(posts[index]),previousSlugs=[...new Set([...(old.previousSlugs||[]),...(slug===update.slug?[]:[slug])])].filter(previousSlug=>previousSlug!==update.slug);
      posts[index]={...old,...update,previousSlugs};await writeJson(blogPostsFile,posts);return json(res,200,normalizedBlogPost(posts[index]))
    });
    if(adminPath&&method==='POST'&&url.pathname==='/api/admin/products')return await mutate(async()=>{
      const products=await loadProducts(),input=await body(req),product=validateProduct(input,products),content=await loadContent();await Promise.all([...product.images,product.socialImage].map(validateImagePath));
      if(!content.categories.includes(product.category))throw fail(400,'Choose a category configured in Homepage & categories.');
      product.id=Math.max(0,...products.map(item=>Number(item.id)||0))+1;product.rating=0;product.reviewCount=0;product.reviews=[];
      products.push(product);await writeJson(productsFile,products);return json(res,201,product);
    });
    const productMatch=url.pathname.match(/^\/api\/admin\/products\/(\d+)$/);
    if(adminPath&&productMatch){
      const id=Number(productMatch[1]),products=await loadProducts(),index=products.findIndex(product=>product.id===id);
      if(index<0)throw fail(404,'Product not found.');
      if(method==='PUT')return await mutate(async()=>{const latest=await loadProducts(),latestIndex=latest.findIndex(product=>product.id===id);if(latestIndex<0)throw fail(404,'Product not found.');const update=validateProduct(await body(req),latest,id),content=await loadContent();await Promise.all([...update.images,update.socialImage].map(validateImagePath));if(!content.categories.includes(update.category))throw fail(400,'Choose a category configured in Homepage & categories.');latest[latestIndex]={...latest[latestIndex],...update,id};await writeJson(productsFile,latest);return json(res,200,latest[latestIndex])});
      if(method==='DELETE')return await mutate(async()=>{const latest=await loadProducts(),latestIndex=latest.findIndex(product=>product.id===id);if(latestIndex<0)throw fail(404,'Product not found.');latest.splice(latestIndex,1);await writeJson(productsFile,latest);const content=await loadContent();content.home.featuredProductIds=(content.home.featuredProductIds||[]).filter(value=>value!==id);await writeJson(contentFile,content);return json(res,200,{ok:true})});
    }
    if(adminPath&&method==='POST'&&url.pathname==='/api/admin/uploads'){const input=await body(req,8*1024*1024),image=await uploadImage(input.data);return json(res,201,{image})}
    if(adminPath&&method==='GET'&&url.pathname==='/api/admin/content'){const [content,products]=await Promise.all([loadContent(),loadProducts()]);return json(res,200,{...content,products:products.map(({id,name})=>({id,name}))})}
    if(adminPath&&method==='PUT'&&url.pathname==='/api/admin/content'){
      const input=await body(req),content=await loadContent(),home=input.home;
      if(!home||typeof home!=='object'||!['season','title','description','image'].every(key=>typeof home[key]==='string'))throw fail(400,'Complete all homepage content fields.');
      if(home.title.length>160||home.description.length>600||home.season.length>100||!/^((assets|uploads)\/[A-Za-z0-9._/-]+)$/.test(home.image)||home.image.includes('..'))throw fail(400,'Homepage text or hero image is invalid.');
      await validateImagePath(home.image);
      const featuredProductIds=Array.isArray(home.featuredProductIds)?[...new Set(home.featuredProductIds.map(Number).filter(Number.isSafeInteger))]:[];
      const products=await loadProducts();if(featuredProductIds.some(id=>!products.some(product=>product.id===id)))throw fail(400,'Featured products must exist in the catalogue.');
      const categories=Array.isArray(input.categories)?[...new Set(input.categories.map(value=>String(value).trim()).filter(Boolean))].slice(0,50):content.categories;
      if(!categories.length||categories.some(category=>category.length>60))throw fail(400,'Add at least one valid category.');
      if(products.some(product=>!categories.includes(product.category)))throw fail(400,'Move products to another category before removing a category in use.');
      await writeJson(contentFile,{...content,categories,home:{season:home.season,title:home.title,description:home.description,image:home.image,featuredProductIds}});
      return json(res,200,{ok:true});
    }
    if(adminPath&&method==='GET'&&url.pathname==='/api/admin/orders')return json(res,200,await loadOrders());
    if(method==='GET'&&url.pathname==='/api/track'){
      const phone=url.searchParams.get('phone')||'';if(!/^[0-9]{10}$/.test(phone))throw fail(400,'Enter the 10-digit phone number used at checkout.');
      const [orders,products]=await Promise.all([loadOrders(),loadProducts()]),id=url.searchParams.get('id')?.trim().toUpperCase();
      if(id){const order=orders.find(item=>item.id===id&&item.customer.phone===phone);return order?json(res,200,{order:publicOrder(order,products)}):json(res,404,{error:'No order matches that ID and phone number.'})}
      const matches=orders.filter(order=>order.customer.phone===phone);return matches.length?json(res,200,{orders:matches.map(order=>publicOrder(order,products))}):json(res,404,{error:'No orders found for that phone number.'});
    }
    if(method==='POST'&&url.pathname==='/api/orders')return await mutate(async()=>{
      const {items,customer,payment}=await body(req);if(payment!=='upi')throw fail(400,'UPI QR payment is the only available payment method.');
      if(!Array.isArray(items)||!items.length||items.some(item=>!item||typeof item!=='object'||!Number.isInteger(Number(item.id))||!Number.isSafeInteger(Number(item.qty))||Number(item.qty)<1)||!validCustomer(customer))throw fail(400,'Please provide valid delivery details and cart items.');
      const products=await loadProducts(),quantities=new Map();for(const item of items){const id=Number(item.id),quantity=(quantities.get(id)||0)+Number(item.qty);if(!Number.isSafeInteger(quantity))throw fail(400,'Requested quantity is too large.');quantities.set(id,quantity)}const normalized=[...quantities].map(([id,qty])=>({id,qty}));
      for(const item of normalized){const product=products.find(entry=>entry.id===item.id&&entry.active!==false);if(!product)throw fail(400,'A product in your cart is no longer available.');if(product.stock!==null&&product.stock!==undefined&&product.stock<item.qty)throw fail(409,`${product.name} does not have enough stock.`)}
      const value=getTotal(normalized,products);if(!Number.isSafeInteger(value)||!value)throw fail(400,'Please provide valid cart items.');
      const [orders]=await Promise.all([loadOrders()]);
      const order={id:'XE'+Date.now().toString().slice(-8)+crypto.randomBytes(2).toString('hex').toUpperCase(),createdAt:new Date().toISOString(),customer,items:normalized.map(item=>{const product=products.find(entry=>entry.id===item.id),tracked=product.stock!==null&&product.stock!==undefined;if(tracked)product.stock-=item.qty;return {...item,name:product.name,stockTracked:tracked}}),total:value,payment:'UPI',status:'Payment pending',inventoryAdjusted:true};
      orders.unshift(order);await writeJson(productsFile,products);await writeJson(ordersFile,orders);return json(res,201,{order:publicOrder(order,products)});
    });
    const orderMatch=url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if(adminPath&&method==='PATCH'&&orderMatch)return await mutate(async()=>{
      const orders=await loadOrders(),order=orders.find(item=>item.id===decodeURIComponent(orderMatch[1]));if(!order)throw fail(404,'Order not found.');
      const update=await body(req),products=await loadProducts();
      if(Object.hasOwn(update,'status')){
        if(typeof update.status!=='string'||!shipmentStatuses.includes(update.status))throw fail(400,'Choose a valid shipment status.');
        const wasCancelled=order.status==='Cancelled',willCancel=update.status==='Cancelled';
        if(order.inventoryAdjusted&&!wasCancelled&&willCancel){for(const item of order.items){const product=products.find(entry=>entry.id===item.id);if(item.stockTracked&&product)product.stock+=item.qty}order.inventoryAdjusted=false}
        if(order.inventoryAdjusted&&wasCancelled&&!willCancel){for(const item of order.items){const product=products.find(entry=>entry.id===item.id);if(item.stockTracked&&product&&product.stock<item.qty)throw fail(409,`${product.name} does not have enough stock to reopen this order.`);if(item.stockTracked&&product)product.stock-=item.qty}order.inventoryAdjusted=true}
        order.status=update.status;
      }
      if(Object.hasOwn(update,'trackingId')){if(typeof update.trackingId!=='string'||update.trackingId.trim().length>80)throw fail(400,'Tracking ID must be 80 characters or fewer.');order.trackingId=update.trackingId.trim()}
      if(!Object.hasOwn(update,'status')&&!Object.hasOwn(update,'trackingId'))throw fail(400,'Provide a shipment status or tracking ID to update.');
      if(Object.hasOwn(update,'status'))await writeJson(productsFile,products);await writeJson(ordersFile,orders);return json(res,200,order);
    });
    return await staticFile(url,res);
  }catch(error){if(error.status)return json(res,error.status,{error:error.message});console.error(error);return json(res,500,{error:'Server error. Please try again.'})}
}).listen(process.env.PORT||3000,()=>console.log(`Xentro running at http://localhost:${process.env.PORT||3000}`));
