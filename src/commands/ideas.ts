import fetch from "node-fetch-commonjs";
import { format as timeago } from "timeago.js";
import { shortenUrl } from "../api/bitly/api";
import { getIdeas, getPrices, searchSymbol } from "../api/tradingview/api";
import { Message } from "../core";
import { BaseCommand } from "../core/BaseCommand";
import { IArgs } from "../core/MessageHandler";

export default class extends BaseCommand {
    name = "ideas";
    public override execute = async (M: Message, args: IArgs): Promise<any> => {
        const result = await searchSymbol(args.args[0]);
        if (!result) throw new Error("Gagal mencari symbol!");
        if (result.length <= 0) return M.reply("Invalid symbol!");
        const symbol = result[0].symbol;
        const proms = [getIdeas(symbol), getPrices([symbol])] as const;
        const [ideas, prices] = await Promise.all(proms);
        const price = prices[0].price;
        const idea = ideas[0];
        const [imageArrayBuffer, sourceLink] = await Promise.all([
            fetch(idea.data.image_url).then((res) => res.arrayBuffer()),
            shortenUrl(idea.data.published_url),
        ]);
        const imageBuffer = Buffer.from(imageArrayBuffer);
        let message = `
		*${idea.data.short_name}* | $${price}\n
		*Title* : ${idea.data.name}\n
		*Date* : ${timeago(idea.timestamp * 1000)}\n
		*Source* : ${sourceLink}`
            .split("\n")
            .map((s) => s.trim())
            .join("\n");

        return M.reply(imageBuffer, "image", false, undefined, message);
    };
}
