// No dependencies, no external requests. Run: node site/check-site.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
const root=resolve(dirname(fileURLToPath(import.meta.url)));
const html=readFileSync(join(root,"index.html"),"utf8");
const css=readFileSync(join(root,"styles.css"),"utf8");
const issues=[];
const checks=(cond,msg)=>{if(!cond)issues.push(msg)};
checks((html.match(/<h1[\s>]/g)||[]).length===1,"expected exactly one h1");
checks(html.includes('<html lang="en">'),"missing English language");
checks(html.includes('youtube-nocookie.com/embed/8ILykmc_WNw'),"missing demo video");
checks(html.includes('id="status"'),"missing status section");
checks(html.includes('MOCK'),"missing simulation disclosure");
checks(html.includes('PENDING_REVIEW'),"missing Sandbox state disclosure");
checks(!/eval\(|new Function\(/.test(html+css),"unexpected dynamic code");
checks(!/https?:\/\/[^"']*\.js/.test(html),"no external JS expected");
const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(x=>x[1]);
checks(ids.length===new Set(ids).size,"duplicate id");
for(const a of html.matchAll(/href="#([^"]+)"/g))checks(ids.includes(a[1]),"broken anchor #"+a[1]);
for(const a of html.matchAll(/(?:href|src)="([^"]+)"/g)){const path=a[1];if(/^https?:\/\//.test(path)||path.startsWith("#"))continue;checks(!path.startsWith("/"),"root absolute URL "+path);checks(existsSync(join(root,path.split(/[?#]/)[0])),"missing asset "+path)}
checks(css.includes("@media(max-width:680px)"),"missing mobile breakpoint");
if(issues.length){for(const x of issues)console.error("FAIL",x);process.exit(1)}
console.log("PASS DIAPORIA Buy static landing validations ("+ids.length+" anchors)");
