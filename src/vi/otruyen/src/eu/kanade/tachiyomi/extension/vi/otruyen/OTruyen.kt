package eu.kanade.tachiyomi.extension.vi.otruyen

import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.await
import eu.kanade.tachiyomi.network.interceptor.rateLimit
import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import keiyoushi.utils.parseAs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

class OTruyen : HttpSource() {

    override val name: String = "OTruyen"

    override val lang: String = "vi"

    override val supportsLatest: Boolean = true

    override val baseUrl: String = "https://otruyen.cc"

    private val apiUrl = "https://otruyenapi.com/v1/api"

    private val legacyCdnUrl = "https://sv1.otruyencdn.com"

    private val imgUrl = "https://img.otruyenapi.com/uploads/comics"

    override val client: OkHttpClient = network.cloudflareClient.newBuilder()
        .rateLimit(3)
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .add("Accept", "application/json")
        .add("Referer", "$baseUrl/")

    override fun latestUpdatesRequest(page: Int): Request = GET(apiUrl.buildApiUrl("danh-sach", "truyen-moi", page = page), headers)

    override fun latestUpdatesParse(response: Response): MangasPage = listingParse(response)

    override fun popularMangaRequest(page: Int): Request = GET(apiUrl.buildApiUrl("danh-sach", "hoan-thanh", page = page), headers)

    override fun popularMangaParse(response: Response): MangasPage = listingParse(response)

    private fun listingParse(response: Response): MangasPage {
        val res = response.parseAs<DataDto<ListingData>>()
        val manga = res.data.items.map { it.toSManga(imgUrl) }
        return MangasPage(manga, res.data.hasNextPage())
    }

    override fun mangaDetailsRequest(manga: SManga): Request = GET(apiUrl.buildApiUrl("truyen-tranh", manga.url), headers)

    override fun mangaDetailsParse(response: Response): SManga {
        val res = response.parseAs<DataDto<EntryData>>()
        return res.data.item.toSManga(imgUrl)
    }

    override fun getMangaUrl(manga: SManga): String = "$baseUrl/truyen-tranh/${manga.url}"

    override fun chapterListRequest(manga: SManga): Request = mangaDetailsRequest(manga)

    override fun chapterListParse(response: Response): List<SChapter> {
        val res = response.parseAs<DataDto<EntryData>>()
        val entry = res.data.item
        return entry.chapters
            .flatMap { server -> server.serverData.map { it.toSChapter(entry.updatedAt, entry.slug) } }
            .sortedByDescending { it.chapter_number }
    }

    override fun getChapterUrl(chapter: SChapter): String = chapter.url.toChapterWebUrl(baseUrl)

    override fun pageListRequest(chapter: SChapter): Request = GET(chapter.url.toChapterApiUrl(legacyCdnUrl), headers)

    override fun pageListParse(response: Response): List<Page> {
        if (!response.isSuccessful) {
            throw Exception("OTruyen chapter CDN HTTP ${response.code}; du lieu cua nguon hien khong kha dung")
        }
        val pages = response.parseAs<DataDto<PageDto>>().data.toPage()
        if (pages.isEmpty()) throw Exception("OTruyen tra ve chapter khong co anh")
        return pages
    }

    override fun imageRequest(page: Page): Request {
        val referer = page.url.takeIf { it.isNotBlank() } ?: "$baseUrl/"
        val imageHeaders = headers.newBuilder()
            .set("Referer", referer)
            .set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
            .build()
        return GET(page.imageUrl!!, imageHeaders)
    }

    override fun imageUrlParse(response: Response): String = throw UnsupportedOperationException()

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        val genre = filters.filterIsInstance<GenreList>().firstOrNull()?.selected
        val status = filters.filterIsInstance<StatusList>().firstOrNull()?.selected ?: StatusList.DEFAULT

        val url = when {
            query.isNotBlank() -> apiUrl.buildApiUrl(
                "tim-kiem",
                page = page,
                queryParams = mapOf("keyword" to query),
            )
            genre != null && genre.slug.isNotBlank() -> apiUrl.buildApiUrl("the-loai", genre.slug, page = page)
            else -> apiUrl.buildApiUrl("danh-sach", status.slug, page = page)
        }

        return GET(url, headers)
    }

    override fun searchMangaParse(response: Response): MangasPage = listingParse(response)

    private fun genresRequest(): Request = GET(apiUrl.buildApiUrl("the-loai"), headers)

    private fun parseGenres(response: Response): List<SelectOption> = response.parseAs<DataDto<GenresData>>()
        .data
        .items
        .mapNotNull { item ->
            if (item.slug.isBlank() || item.name.isBlank()) {
                null
            } else {
                SelectOption(item.name, item.slug)
            }
        }

    private var genreList: List<SelectOption> = emptyList()

    private var fetchGenresAttempts: Int = 0

    private fun fetchGenres() {
        if (genreList.isNotEmpty() || fetchGenresAttempts >= 3) return

        fetchGenresAttempts++
        launchIO {
            try {
                client.newCall(genresRequest()).await()
                    .use { parseGenres(it) }
                    .takeIf { it.isNotEmpty() }
                    ?.also { genreList = listOf(SelectOption("Tất cả", "")) + it }
            } catch (_: Exception) {
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun launchIO(block: suspend () -> Unit) = scope.launch { block() }

    override fun getFilterList(): FilterList {
        fetchGenres()
        return if (genreList.isEmpty()) {
            FilterList(
                Filter.Header("Nhấn 'Làm mới' để tải thể loại từ OTruyen API"),
                Filter.Header("Khi tìm theo tên, các bộ lọc bên dưới sẽ bị bỏ qua"),
                StatusList(),
            )
        } else {
            FilterList(
                Filter.Header("Khi tìm theo tên, các bộ lọc bên dưới sẽ bị bỏ qua"),
                StatusList(),
                GenreList("Thể loại", genreList),
            )
        }
    }

    private fun String.buildApiUrl(
        vararg segments: String,
        page: Int? = null,
        queryParams: Map<String, String> = emptyMap(),
    ): String = toHttpUrl().newBuilder().apply {
        segments.filter { it.isNotBlank() }.forEach { addPathSegment(it) }
        if (page != null) {
            addQueryParameter("page", page.toString())
        }
        queryParams.forEach { (key, value) -> addQueryParameter(key, value) }
    }.build().toString()

    private class GenreList(name: String, options: List<SelectOption>) : Filter.Select<SelectOption>(name, options.toTypedArray()) {
        val selected: SelectOption get() = values[state]
    }

    private class StatusList : Filter.Select<SelectOption>("Trạng thái", OPTIONS) {
        val selected: SelectOption get() = values[state]

        companion object {
            val DEFAULT = SelectOption("Truyện mới", "truyen-moi")

            private val OPTIONS = arrayOf(
                DEFAULT,
                SelectOption("Đang phát hành", "dang-phat-hanh"),
                SelectOption("Hoàn thành", "hoan-thanh"),
                SelectOption("Sắp ra mắt", "sap-ra-mat"),
            )
        }
    }

    private class SelectOption(val name: String, val slug: String) {
        override fun toString(): String = name
    }
}
