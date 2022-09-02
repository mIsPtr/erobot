import { proto } from "@adiwajshing/baileys";
import { JSONFile, Low } from "@commonify/lowdb";
import binanceApiNode, { Binance } from "binance-api-node";
import { debounce } from "debounce";
import EventEmitter from "events";
import { writeFileSync } from "fs";
import pMap from "p-map";
import { ema } from "technicalindicators";
import TypedEmitter from "typed-emitter";
import { ROOT_DIR } from "../..";
import { Client } from "../../core";
import { LowDB } from "../../core/LowDB";
import { getPercentageChange } from "../../helper/utils";
// prettier-ignore
export type Interval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "8h" | "12h" | "1d" | "3d" | "1w" | "1M";

interface Candle {
    open: number;
    high: number;
    low: number;
    close: number;
    closeTime: number;
    openTime: number;
}

type Data = { symbol: string; candles: Candle[]; isFinal: boolean };
type StreamCallback = (data: Data) => void;

interface AlertType {
    symbol: string;
    alertPrice: string;
    done: boolean;
    amGreater?: boolean | undefined;
    msg: proto.IWebMessageInfo;
    resolved: boolean;
}

type Events = {
    alert: (data: { symbol: string; currentPrice: number; alert: AlertType }) => void;
    streamedSymbol: (data: { symbol: string; currentPrice: number }) => void;
};

export class BinanceClient {
    db: LowDB<AlertType[]>;
    bullishDb: LowDB<{ [symbol: string]: number }>;
    bullishEmaDb: LowDB<{ [symbol: string]: { countdown: number; msg?: proto.IWebMessageInfo } }>;
    avgDb: LowDB<{ [symbol: string]: { timeStamp: number; msg?: proto.IWebMessageInfo } }>;
    dbPnd: LowDB<Record<string, { createdAt: number; lastPrice: number }>>;

    binanceClient: Binance;
    evt: TypedEmitter<Events>;

    tickers = new Map<string, Candle[]>();
    // rsis = new Map<string, number[]>();
    symbols: string[];

    private streamingCandles = false;
    constructor(public client: Client, streamCandles: boolean = false) {
        this.bullishDb = new LowDB<{ [symbol: string]: number }>(`${ROOT_DIR}/json/binance_bullish.json`, {});
        this.bullishEmaDb = new LowDB<{ [symbol: string]: { countdown: number; msg?: proto.IWebMessageInfo } }>(
            `${ROOT_DIR}/json/binance_bullish_ema.json`,
            {}
        );
        this.db = new LowDB<AlertType[]>(`${ROOT_DIR}/json/binance_alerts.json`, []);
        this.avgDb = new LowDB<{ [symbol: string]: { timeStamp: number; msg?: proto.IWebMessageInfo } }>(
            `${ROOT_DIR}/json/binance_avgpnd.json`,
            {}
        );
        this.dbPnd = new LowDB<Record<string, { createdAt: number; lastPrice: number }>>(
            `${ROOT_DIR}/json/binance_pnd.json`,
            {}
        );

        this.binanceClient = binanceApiNode({});
        this.evt = new EventEmitter() as TypedEmitter<Events>;
        if (streamCandles) {
            this.getFuturesSymbols().then((symbols) => {
                this.streamCandles(symbols, "5m", 200, (data) => {
                    const currentPrice = data.candles[data.candles.length - 1].close;
                    this.handleAlert(data.symbol, currentPrice);
                    this.handlePnD(data.symbol, currentPrice); //Pump And Dump
                    //this.handleBnB(data); //Bullish And Bearish
                    this.handleAvgPnD(data);
                    this.handleAboveEma(data);

                    this.evt.emit("streamedSymbol", {
                        symbol: data.symbol,
                        currentPrice,
                    });
                });
            });
        }
    }

    private async onAlert(cb: (data: { symbol: string; currentPrice: number; alert: AlertType }) => void) {
        this.evt.on("alert", (data) => {
            cb(data);
        });
    }

    async addAlert(symbol: string, price: number, msg: proto.IWebMessageInfo) {
        try {
            const data = await this.getSymbolData(symbol);
            console.log("addAlert data", data);
            const alert: AlertType = {
                alertPrice: price.toString(),
                symbol,
                done: false,
                msg,
                resolved: false,
                amGreater: price > data.currentPrice,
            };
            this.db.data?.push(alert);
            this.db.write();
            const gap = getPercentageChange(price, data.currentPrice);
            return this.client.sendMessage(
                msg.key.remoteJid!,
                {
                    text: `Alert added for ${symbol} at ${price}\nCurrent price: ${
                        data.currentPrice
                    }\nGap : ${gap.toFixed(2)}%`,
                },
                { quoted: msg }
            );
        } catch (error) {
            console.log(error);
            throw error;
        }
    }

    async getSymbolData(symbol: string) {
        if (!this.streamingCandles) {
            throw new Error("Not streaming candles");
        }
        return new Promise<{ symbol: string; currentPrice: number }>((res, rej) => {
            this.evt.on("streamedSymbol", ({ symbol: pair, currentPrice }) => {
                if (pair === symbol) {
                    res({
                        symbol: pair,
                        currentPrice,
                    });
                }
            });
            setTimeout(() => {
                rej("Timeout");
            }, 1000 * 5);
        });
    }

    private async handleAboveEma(data: Data) {
        if (!data.isFinal) return;
        const db = this.bullishEmaDb.data;
        if (!db[data.symbol]) db[data.symbol] = { countdown: 0 };

        let MAX_INDEX = 10;
        const ema25 = ema({ period: 25, values: data.candles.map((c) => c.close) }).reverse();
        const ema99 = ema({ period: 99, values: data.candles.map((c) => c.close) }).reverse();

        const candles = data.candles
            .slice(0)
            .reverse()
            .map((c, i) => ({ close: c.close, ema25: ema25[i], ema99: ema99[i] }))
            .filter((_c, i) => i < MAX_INDEX)
            .reverse();

        let bullish = true;

        for (const candle of candles) {
            if (candle.close > candle.ema25 && candle.ema25 > candle.ema99) continue;
            bullish = false;
        }
        if (db[data.symbol].countdown-- <= 0) db[data.symbol].countdown = 0;
        if (bullish && db[data.symbol].countdown <= 0) {
            this.bullishEmaDb.data[data.symbol].countdown = 10;
            const currentPrice = candles[candles.length - 1].close;
            const lastPrice = candles[0].close;
            const percentGap = getPercentageChange(currentPrice, lastPrice);
            console.log(`${data.symbol} LONG!`);
            // console.log(candles.length, data.candles.length);
            this.client.sendMessageQueue(
                "62895611963535-1631537374@g.us",
                { text: `${data.symbol} LONG | ${percentGap.toFixed(2)}%\nCurrent Price : $${currentPrice}` },
                { quoted: db[data.symbol].msg },
                (msg) => {
                    db[data.symbol].msg = msg;
                    this.bullishEmaDb.write();
                }
            );
        }
        await this.bullishEmaDb.write();
    }

    private async handleAvgPnD(data: Data) {
        if (this.avgDb.data[data.symbol] === undefined) {
            this.avgDb.data[data.symbol] = { timeStamp: Date.now() };
            await this.avgDb.write();
        }
        const MAX_INDEX = 8;
        const candles = data.candles
            .slice(0)
            .reverse()
            .filter((_c, i) => i < MAX_INDEX);

        const current = candles[0];
        let totalPercent = 0;
        let count = 0;
        candles.forEach((candle, idx) => {
            if (idx === 0) return;
            const percent = getPercentageChange(candle.close, candle.open);
            totalPercent += percent;
            count++;
        });
        const avg = totalPercent / count;
        const currentPercent = getPercentageChange(current!.close, current!.open);

        if (currentPercent > avg * 7 && Date.now() - this.avgDb.data[data.symbol].timeStamp >= 1000 * 60 * 10) {
            // console.log(data.symbol, avg.toFixed(2), currentPercent.toFixed(2));
            const pompom = current.close > current.open;

            this.avgDb.data[data.symbol].timeStamp = Date.now();
            const text = `${data.symbol.padEnd(10)} => ${`${current.close}`.padEnd(7)} | LAST ${
                candles.length - 1
            } % AVG : ${avg.toFixed(2).padEnd(5)}% | CURRENT % : ${pompom ? "" : "-"}${currentPercent.toFixed(2)}%`;

            console.log(text);
            // console.log(data.candles.map((c) => c.close));
            if (pompom) {
                const msg = await this.client.sendMessage(
                    "120363023114788849@g.us",
                    {
                        text: `Average Pump! *${data.symbol}* => ${currentPercent.toFixed(2)}%\nCurrent Price : $${
                            current.close
                        }`,
                    },
                    { quoted: this.avgDb.data[data.symbol]?.msg }
                );
                this.avgDb.data[data.symbol].msg = msg;
                await this.avgDb.write();
            } else {
                if (data.symbol === "BTCUSDT") {
                    const msg = await this.client.sendMessage(
                        "120363023114788849@g.us",
                        {
                            text: `Average Dump! *${data.symbol}* => -${currentPercent.toFixed(2)}%\nCurrent Price : $${
                                current.close
                            }`,
                        },
                        { quoted: this.avgDb.data[data.symbol]?.msg }
                    );
                    this.avgDb.data[data.symbol].msg = msg;
                    await this.avgDb.write();
                }
            }
        }
    }

    private datas: Data[] = [];
    private deb = debounce(async () => {
        // console.log(this.datas.length);
        let messages = "";
        for (const data of this.datas) {
            const currentPrice = data.candles[data.candles.length - 1].close;
            const lastPrice = data.candles[0].close;
            const percentGap = getPercentageChange(currentPrice, lastPrice);
            const text = `${data.symbol} => ${percentGap.toFixed(2)}%\n${lastPrice} => ${currentPrice}`;
            console.log(`${data.symbol} => ${percentGap.toFixed(2)}%`);
            this.bullishDb.data[data.symbol] = 5;
            messages += `${text}\n======================\n`;
        }
        console.log("debounced");
        if (this.datas.length <= 0) return;
        await this.client.sendMessage("120363023114788849@g.us", { text: messages });
        await this.bullishDb.write();
        this.datas = [];
    }, 500);

    private debo = (data: Data) => {
        this.datas.push(data);
        this.deb();
    };

    private async handleBnB(data: Data) {
        if (data.isFinal) {
            const db = this.bullishDb.data;
            if (!db[data.symbol]) db[data.symbol] = 0;

            let bullish = true;
            let count = 0; // error count
            let MAX_INDEX = 7;
            const candles = data.candles
                .slice(0)
                .reverse()
                .filter((_c, i) => i < MAX_INDEX)
                .reverse();
            // console.log(candles.length, data.candles.length);
            for (const candle of candles) {
                if (candle.open > candle.close) {
                    if (count-- <= 0) {
                        bullish = false;
                        break;
                    }
                }
            }

            if (db[data.symbol]-- <= 0) db[data.symbol] = 0;
            if (bullish && db[data.symbol] <= 0) {
                this.debo(data);
                console.log(candles.length, data.candles.length);
            }
            await this.bullishDb.write();
        }
    }

    private async handlePnD(symbol: string, currentPrice: number) {
        const current = this.pnd[symbol];
        if (!current && !symbol.endsWith("BUSD")) {
            console.log("New symbol", symbol);
            this.pnd[symbol] = { createdAt: Date.now(), lastPrice: currentPrice };
            await this.dbPnd.write();
            return;
        } else if (current) {
            const isExpired = Date.now() - current.createdAt > 1000 * 60 * 10; //n minutes
            const percentGap = getPercentageChange(current.lastPrice, currentPrice);
            if (isExpired) {
                this.pnd[symbol] = {
                    createdAt: Date.now(),
                    lastPrice: currentPrice,
                };
                await this.dbPnd.write();
            } else if (percentGap > 5) {
                const pompom = currentPrice > current.lastPrice;
                const time = Date.now() - current.createdAt;
                let ago = Math.floor(time / 1000 / 60);
                let seconds: number | undefined;
                let useSecond = false;
                if (ago === 0) {
                    useSecond = true;
                    seconds = Math.floor(time / 1000);
                    ago = seconds;
                }
                this.client.sendMessage("120363023114788849@g.us", {
                    text: `${pompom ? "📈📈📈 Pump" : "📉📉📉 Dump"} alert for *${symbol}*\n${
                        pompom ? "" : "-"
                    }${percentGap.toFixed(2)}%\nLast Price (${ago} ${useSecond ? "seconds" : "minutes"} ago): $${
                        current.lastPrice
                    }\nCurrent Price : $${currentPrice}`.trim(),
                });

                delete this.pnd[symbol];
                await this.dbPnd.write();
                console.log("pnd saved");
            }
        }
    }

    private async handleAlert(symbol: string, currentPrice: number) {
        this.db.data?.forEach((alert, idx) => {
            if (alert.symbol !== symbol) return;
            if (alert.done) return;

            const alertPrice = Number.parseFloat(alert.alertPrice);
            if (alert.amGreater === undefined) {
                alert.amGreater = alertPrice > currentPrice;
                this.db.write().then(() => console.log("Saved alert on amGreater"));
            }

            const percentChange = getPercentageChange(currentPrice, alertPrice);
            const crossOrClose = alert.amGreater === false ? currentPrice <= alertPrice : currentPrice > alertPrice;

            // console.log(
            // 	"handleAlert",
            // 	"symbol",
            // 	symbol,
            // 	"currentPrice",
            // 	currentPrice,
            // 	"alertPrice",
            // 	alertPrice,
            // 	"percentChange",
            // 	percentChange,
            // 	"crossOrClose",
            // 	crossOrClose,
            // 	"alert.amGreater",
            // 	alert.amGreater
            // );

            if (percentChange <= 0.01 || crossOrClose) {
                // this.evt.emit("alert", { symbol, currentPrice, alert });
                alert.done = true;
                this.client
                    .sendMessage(
                        alert.msg.key.remoteJid!,
                        {
                            // text: `Alert for ${symbol} at ${alertPrice} triggered at ${currentPrice}`,
                            text: `⏰ Alert triggered! ⏰\nFor ${symbol} at ${alertPrice}\nCurrent Price : ${currentPrice}`,
                        },
                        { quoted: alert.msg }
                    )
                    .then(() => {
                        const idx = this.db.data?.indexOf(alert) ?? -1;
                        if (idx > -1) {
                            this.db.data?.splice(idx, 1);
                            this.db.write().then(() => console.log("Saved alert"));
                        }
                    })
                    .catch(() => {
                        alert.done = false;
                    });
            }
        });
    }

    async getCandles(pairs: string[], interval: Interval, limit: number, includeCurrentCandle: boolean) {
        if (limit > this.MAX_CANDLE_LIMIT)
            throw new Error("Limit number exceeded maximum length of " + this.MAX_CANDLE_LIMIT);
        this.client.log(
            `Getting all candles for ${pairs.length} pairs, timeframe ${interval}, limit ${limit}`,
            "yellow"
        );
        const errorCandles: string[] = [];
        const successCandles: { symbol: string; candles: Candle[] }[] = [];
        const lastTime = new Date().getTime();
        const proms = pairs.map(async (symbol) => {
            try {
                const ticker = await this.binanceClient.futuresCandles({
                    interval,
                    symbol,
                    limit,
                });
                const candles: Candle[] = ticker.map((c) => ({
                    open: Number(c.open),
                    high: Number(c.high),
                    low: Number(c.low),
                    close: Number(c.close),
                    openTime: c.openTime,
                    closeTime: c.closeTime,
                }));
                if (includeCurrentCandle === false) {
                    candles.pop();
                }
                //this.tickers.set(symbol, candles);
                successCandles.push({ symbol, candles });
            } catch (error) {
                errorCandles.push(symbol);
            }
        });
        await pMap(proms, (p) => p, { concurrency: 2 });
        const nowTime = new Date().getTime();
        this.client.log(`Time to get candles : ${(nowTime - lastTime) / 1000}s`, "yellow");
        this.client.log(`Got all past candles except for ${errorCandles}`, "yellow");
        this.client.log(`Total pairs: ${successCandles.length}`, "yellow");
        return successCandles;
    }

    private async streamCandles(pairs: string[], interval: Interval, limit: number, streamCB: StreamCallback) {
        const data = await this.getCandles(pairs, interval, limit, false);
        data.forEach((val) => {
            this.tickers.set(val.symbol, val.candles);
        });
        this.streamingCandles = true;
        this.binanceClient.ws.futuresCandles(pairs, interval, (candle) => {
            const symbol = candle.symbol;
            const candles = this.tickers.get(symbol);
            if (!candles) {
                console.log("no candles", symbol);
                return;
            }
            // const pastCandle = candles.map((c) => c.close);
            // const newValues = [...pastCandle, Number(candle.close)];
            // const rsi = RSI.calculate({
            // 	period: 14,
            // 	values: newValues,
            // });
            // const ema99 = EMA.calculate({
            // 	period: 99,
            // 	values: newValues,
            // });
            // const currentRSI = rsi[rsi.length - 1];
            // const previousRSI = rsi[rsi.length - 2];
            if (candle.isFinal) {
                candles.push({
                    open: Number(candle.open),
                    high: Number(candle.high),
                    low: Number(candle.low),
                    close: Number(candle.close),
                    openTime: candle.startTime + 1000,
                    closeTime: candle.closeTime + 1000,
                });
            }

            streamCB({
                symbol,
                candles: !candle.isFinal
                    ? [
                          ...candles,
                          {
                              open: Number(candle.open),
                              high: Number(candle.high),
                              low: Number(candle.low),
                              close: Number(candle.close),
                              openTime: candle.startTime + 1000,
                              closeTime: candle.eventTime + 1000,
                          },
                      ]
                    : candles,
                isFinal: candle.isFinal,
            });

            if (candle.isFinal) {
                if (candles.length >= limit) {
                    candles.shift();
                }
            }

            // const current = this.rsis.get(symbol);
            // if (currentRSI > 70 && previousRSI < 70 && !current) {
            // 	this.rsis.set(symbol, rsi);
            // 	console.log("RSI", symbol, rsi[rsi.length - 1]);
            // } else if (currentRSI < 30 && previousRSI > 30 && !current) {
            // 	this.rsis.set(symbol, rsi);
            // 	console.log("RSI", symbol, rsi[rsi.length - 1]);
            // }
        });
    }

    private async getFuturesTickers() {
        const ts: string[] = [];
        this.binanceClient.ws.futuresAllTickers((tickers) => {
            for (const ticker of tickers) {
                if (ts.includes(ticker.symbol)) {
                    console.log("duplicate", ticker.symbol);
                    continue;
                }
                ts.push(ticker.symbol);
                console.log("ticker", ticker.symbol, ts.length);
            }
            writeFileSync("tickers.json", JSON.stringify(ts));
        });
    }

    async getFuturesSymbols() {
        const exchangeInfo = await this.binanceClient.futuresExchangeInfo();
        if (!this.symbols) this.symbols = exchangeInfo.symbols.map((s) => s.symbol);
        return this.symbols.filter(
            (s) => !["ICPUSDT", "BTSUSDT", "BTCSTUSDT", "SCUSDT", "TLMUSDT"].includes(s) && s.endsWith("USDT")
        );
    }

    public get pnd() {
        return this.dbPnd.data!;
    }

    public get MAX_CANDLE_LIMIT() {
        return 500;
    }
}
