import { JSONFile, Low } from "@commonify/lowdb";

export class LowDB<T> implements Low<T> {
    data!: T;
    write!: Low<T>["write"];
    read!: Low<T>["read"];
    adapter!: Low<T>["adapter"];
    private low: Low<T>;
    constructor(filename: string, initialIfNull: T, onRead?: (data: T) => void) {
        this.low = new Low(new JSONFile<T>(filename));
        this["data"] = this.low["data"] as T;
        this["adapter"] = this.low["adapter"];
        this["write"] = this.low["write"];
        this["read"] = this.low["read"];

        this.write().then(async () => {
            await this.read();
            this.data ||= initialIfNull;
            onRead?.(this.data);
        });
    }
}
