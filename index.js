const Koa = require('koa');
const koaBody = require('koa-body');
const levelup = require('levelup');
const leveldown = require('leveldown');
const nodejieba = require("nodejieba");
const fs = require('fs');
const readline = require('readline');
const fetch = require('node-fetch');
const Router = require('koa-router');

const app = new Koa();

let db = levelup(leveldown('./data'));


db.get(',', (err, res) => {
    if (err) console.error(err);
    console.log('start write..', res);

    if (!res) {
        const r1 = readline.createInterface({
            input: fs.createReadStream("./idf.txt")
        });

        let i = 0;
        r1.on('line', (line) => {
            let name = line.split(' ');
            if (name[0].trim()) {
                db.put(name[0].trim(), name[1].trim());
            }

            i++;
            if (i%100000===0) {
                console.log('add: ' + i);
            }
        });
    }

});

app.use(koaBody());

const router = new Router();
const step_words = require('./step_words');

router.post('/keyword_random', async ctx => await keyword_random(ctx));

router.post('/tf-idf', async ctx => {
    let body = ctx.request.body||{};
    let limit = ctx.query.limit?parseInt(ctx.query.limit):10;
    let raw = nodejieba.cut(body.content);

    let words = await tf_idf(raw,limit);

    // update
    await tf_idf_update(words, body.UniqueID);

    ctx.body = {code:0, words};
});

router.post('/tf-idf_sort', async ctx => {
    let body = ctx.request.body||{};
    let keywords = null;
    let db_key = 'keywords_' + body.UniqueID;

    try {
        keywords = JSON.parse(await db.get(db_key));
    } catch(e) {}

    keywords = keywords || [];

    for (let data of body.data) {
        let raw = nodejieba.cut(data.title + ' ' + data.content);
        data.tf_idf = [];

        for (let word of keywords) {
            for (let word1 of raw) {
                if (word.key === word1) {
                    word.weight = (word.weight||0)+1;
                }
            }

            if (word.weight) {
                let tf = word.weight / raw.length;
                let idf = parseFloat((await db.get(word.key))||'0');
                data.tf_idf.push(tf * idf);
            }
        }

        data.tf_idf = eval(data.tf_idf.join('+'));
    }

    let data = body.data.sort( (a,b) => a.tf_idf < b.tf_idf ? 1: -1 );

    ctx.body = {code:0, data};
});

const hosts = ['https://www.google.com', 'https://zh.wikipedia.org', 'https://upload.wikimedia.org'];

router.get('/p/*', async (ctx,next) => {
    let urls = ctx.url.replace('/p/','').split(';;;');
    let url = decodeURI(new Buffer(urls[0], 'base64').toString());
    let host;

    hosts.map((h)=> {
        if (url.startsWith(h))  host = h;
    });

    if (!url || !host) {
        return await next();
    }

    let header = ctx.req.headers;
    delete header['host'];
    delete header['referer'];

    let res = await fetch(url + (urls[1]||''), {
        includes: true,
        headers: header,
    });


    for(let key of res.headers.keys()) {
        if (['Content-Length','content-encoding'].includes(key)) continue;
        ctx.set(key, res.headers.get(key));
    }


    if (res.headers.get("content-type").startsWith('text')) {
        let body = await res.text();

        [`'`, `"`].map(s => {
            let regexp = new RegExp(`${s}(?!/p/)\/[ \\w\\/\\.:\&\?\%;\=\%-,\s-]+${s}`);

            while (body.match(regexp)) {
                let m = body.match(regexp);

                let m1 = m[0].substr(1, m[0].length-2).replace(/&amp;/g,'&');

                let m_url;

                if (m1.includes(', ')) {
                    m1 = m1.split(', ');

                    m_url = m1.map(z => {
                        let z1 = z.split(' ');
                        return new Buffer(encodeURI(z1[0].startsWith('//')?`https:${z1[0]}`:`${host}/${z1[0]}`)).toString('base64')
                            + (' '+z1[1]||'');
                    }).join(', ');

                } else {
                    m1 = m1.startsWith('//')?`https:${m1}`:`${host}${m1}`;
                    m_url = new Buffer(encodeURI(m1)).toString('base64');
                }

                body = body.replace(m[0], `${s}/p/` + m_url + `;;;${s}`);
            }

        });

        ctx.body = body;

    } else {
        ctx.body = res.body;
    }

    ctx.status = res.status;
});


app.use(router.routes())
    .use(router.allowedMethods());

app.use(ctx => ctx.redirect('https://cn.bing.com/'));


async function keyword_random(ctx) {
    let body = ctx.request.body||{};
    let limit = ctx.query.limit?parseInt(ctx.query.limit):null;
    let number = ctx.query.number?parseInt(ctx.query.number):1;
    let keywords = null;
    let db_key = 'keywords_' + body.UniqueID;

    try {
        keywords = JSON.parse(await db.get(db_key));
    } catch(e) {}

    keywords = keywords || [];
    let min = 0, max = keywords.length;

    if (limit && limit < keywords.length) {
        max = limit;
    }

    let words = [];

    for (let i = 0; i < number; i++) {
        words.push(keywords[Math.floor(Math.random()*(max-min+1)+min)]);
    }

    ctx.body = {code:0, words };
}

async function tf_idf(raw,limit) {
    let words = [];

    for (let i = 0; i < raw.length; i++) {
        if (!raw[i]||step_words.includes(raw[i])) continue;

        let word = null;

        for (let z = 0; z < words.length; z++) {
            if (words[z].key === raw[i]) {
                word = words[z];
                break;
            }
        }

        if (!word && raw[i].length > 1) {
            word = { key: raw[i], weight: 0 };
            words.push(word);
        }

        if (word)
            word.weight++;
    }

    for (let word of words) {
        try {
            let tf = word.weight / words.length;
            let idf = parseFloat((await db.get(word.key))||'0');
            word.tf_idf = tf * idf;
            delete word.weight;
        } catch(e) { }
    }

    words = (words.sort((a,b)=>a.tf_idf>b.tf_idf?-1:1).slice(0,limit));

    return words;
}

async function tf_idf_update(words, UniqueID) {
    let keywords = null;
    let db_key = 'keywords_' + UniqueID;

    try {
        keywords = JSON.parse(await db.get(db_key));
    } catch(e) {}

    keywords = keywords || [];

    for (let word of words) {
        let is_has = false;

        for (let word1 of keywords) {
            if (word1.key === word.key) {
                word1.tf_idf = (word1.tf_idf + word1.tf_idf)/2;
                is_has = true;
                break;
            }
        }

        if(!is_has && word.key.length > 1) {
            keywords.push(word);
        }
    }

    await db.put(db_key, JSON.stringify (keywords));
}

app.listen(80);
