import { Message } from "../core";
import { BaseCommand } from "../core/BaseCommand";
import { Command } from "../core/Command";
import { IArgs } from "../core/MessageHandler";
import { countDecimalPlaces, getPercentageChange } from "../helper/utils";

@Command("trades", {
    description: "",
    usage: "",
})
export default class extends BaseCommand {
    public override execute = async (M: Message, args: IArgs): Promise<any> => {
        const binance = this.client.binance;
        const trades = binance.dbTrade.data;
        let symbols = trades.map((t) => t.symbol);
        console.log(symbols.length);
        symbols = [...new Set(symbols)];
        console.log(symbols.length);

        const candles = await binance.getCandles(symbols, "1m", 1, true);
        const data = trades
            .filter((t) => {
                const current = candles.find((c) => c.symbol === t.symbol);
                if (!current) return false;
                const jid = t.msg?.key.remoteJid!;
                if (jid !== M.from) return false;
                if (t.sl.hit) return false;
                if (!current) {
                    console.log("No " + t.symbol);
                    return false;
                }
                const hitTp = t.tp.some((a) => a.hit);
                if (!hitTp) return false;
                const hitEntry = t.entries.some((a) => a.hit);
                if (!hitEntry) return false;
                return true;
            })
            .map((t) => {
                const current = candles.find((c) => c.symbol === t.symbol)!;
                const currentPrice = current.candles[current.candles.length - 1].close;
                const precision = countDecimalPlaces(currentPrice);
                const hitEntry = t.entries.some((a) => a.hit);
                const entries = t.entries.filter((a) => a.hit);
                const entryPrice = hitEntry
                    ? entries.reduce((acc, curr) => acc + curr.price, 0) / entries.length
                    : t.entry
                    ? t.entry
                    : t.entries[0].price;
                let percentGap = getPercentageChange(currentPrice, entryPrice);
                const isMines = currentPrice < entryPrice;
                percentGap = isMines ? percentGap * -1 : percentGap;
                return {
                    currentPrice,
                    symbol: t.symbol,
                    entryPrice: Number(entryPrice.toFixed(precision)),
                    percentGap,
                    done: !t.tp.some((a) => a.hit === false),
                };
            });

        const running = data.filter((d) => !d.done);

        let text = "=====| Running Trade |=====\nSymbol | Price | Current | Gain/Loss\n";
        running
            .sort((a, b) => (a.percentGap < b.percentGap ? 1 : -1))
            .forEach(({ currentPrice, entryPrice, percentGap, symbol }) => {
                text += `${symbol} | $${entryPrice} | $${currentPrice} | ${percentGap.toFixed(2)}%\n`;
            });
        text += "\n=====| Finished Trade |=====\nSymbol | Price | Current | Gain/Loss\n";
        data.filter((d) => d.done)
            .sort((a, b) => (a.percentGap < b.percentGap ? 1 : -1))
            .forEach(({ currentPrice, entryPrice, percentGap, symbol }) => {
                text += `${symbol} | $${entryPrice} | $${currentPrice} | ${percentGap.toFixed(2)}%\n`;
            });
        return M.reply(text);
    };
}