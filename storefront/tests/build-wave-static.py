import json, re, pathlib
from html.parser import HTMLParser
class Head(HTMLParser):
 def __init__(self): super().__init__(); self.meta={};self.canonical='';self.intitle=False;self.title='';self.resources=[]
 def handle_starttag(self,t,attrs):
  a=dict(attrs)
  if t=='meta':self.meta[a.get('name',a.get('property',''))]=a.get('content','')
  if t=='link' and a.get('rel')=='canonical':self.canonical=a.get('href','')
  if t=='title':self.intitle=True
  if t in ['img','script','video','source']:self.resources += [a.get('src','')]
 def handle_endtag(self,t):
  if t=='title':self.intitle=False
 def handle_data(self,s):
  if self.intitle:self.title+=s
repo=pathlib.Path.cwd(); xml=(repo/'storefront/audit/original-sitemap.xml').read_text(); routes=[re.sub(r'https://lady-elka.ru','',r) or '/' for r in re.findall(r'<loc>(.*?)</loc>',xml)]
evidence={'baselineFromParityAudit':{'pages':57,'description':27,'ogTitle':51,'ogDescription':24,'ogImage':1},'artifacts':{}}
for mode,base in [('preview',repo/'storefront/dist'),('production',repo/'storefront/production/dist')]:
 rows=[]
 for route in routes:
  path=base/('index.html' if route=='/' else route.lstrip('/')+'/index.html')
  if not path.exists():path=base/(route.lstrip('/')+'.html')
  h=Head();h.feed(path.read_text()); row={'route':route,'title':h.title,'description':h.meta.get('description'),'ogTitle':h.meta.get('og:title'),'ogDescription':h.meta.get('og:description'),'ogImage':h.meta.get('og:image'),'canonical':h.canonical,'robots':h.meta.get('robots')};rows.append(row)
  for k in ['description','ogTitle','ogDescription','ogImage']: assert row[k],(mode,route,k)
  assert not any(r.startswith('http') for r in h.resources),(mode,route,'hotlink')
  assert 'Разнообранзный' not in h.title
  for key in ['ogImage']:
   local=row[key].removeprefix('https://lady-elka.ru/')
   assert (base/local).is_file(),(route,key,local)
 sitemap=(base/'sitemap.xml').read_text();assert all('https://lady-elka.ru'+r+'<' not in sitemap for r in ['/testy','/spasibo','/catalog-tree-1'])
 manifest=json.loads((base/'build-manifest.json').read_text()); sizes=[]
 for original,v in manifest['endpoints']['thumbnails'].items():
  before=(base/original.lstrip('/')).stat().st_size;sizes.append({'original':original,'before':before,'thumb240':v['240']['bytes'],'thumb480':v['480']['bytes']})
 evidence['artifacts'][mode]={'pages':rows,'completeMetadata':len(rows),'sitemapURLs':len(re.findall('<loc>',sitemap)),'thumbnails':len(sizes)*2,'imageBytes':{'originals':sum(s['before'] for s in sizes),'thumb240':sum(s['thumb240'] for s in sizes),'thumb480':sum(s['thumb480'] for s in sizes)},'samples':sizes[:3]}
(repo/'agent-context/build-wave-static.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n');print(json.dumps({k:{x:y for x,y in v.items() if x not in ['pages','samples']} for k,v in evidence['artifacts'].items()},ensure_ascii=False))
