const Koa = require('koa');
const koaBody = require('koa-body');
const levelup = require('levelup');
const leveldown = require('leveldown');
const nodejieba = require("nodejieba");
const zlib = require('zlib');
const fs = require('fs');

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
            if (i%100000==0) {
                console.log('add: ' + i);
            }
        });
    }

});


app.use(koaBody());

const step_words = require('./step_words');

app.use(async ctx => {
    switch (ctx.path) {
        case '/keyword_random':
            await keyword_random(ctx);
            break;

        case '/tf-idf':
            await (async() => {
                let body = ctx.request.body||{};
                let limit = ctx.query.limit?parseInt(ctx.query.limit):10;
                let raw = nodejieba.cut(body.content);

                let words = await tf_idf(raw,limit);

                // update
                await tf_idf_update(words, body.UniqueID);

                ctx.body = {code:0, words};
            })();

            break;

        case '/tf-idf_sort':
            await (async() => {
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
            })();
            break;

        default:
            ctx.statusCode=404;
    }
});

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

app.listen(3000);
