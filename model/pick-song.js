import Base from './base.js'

export default class PickSongList extends Base {
    constructor (e) {
        super(e)
        this.model = 'pick-song'
    }

    /** 生成点歌列表图片 */
    async getData (songData = [], platform = 'netease') {
        // 酷狗使用独立浅色列表模板，网易云保持原深色模板
        this.model = platform === 'kugou' ? 'pick-song-kugou' : 'pick-song'
        const list = Array.isArray(songData) ? songData : []
        return {
            ...this.screenData,
            saveId: this.model,
            songData: list,
            songCount: list.length,
            platform,
            platformLabel: platform === 'kugou' ? '酷狗音乐' : '网易云音乐',
        }
    }
}
