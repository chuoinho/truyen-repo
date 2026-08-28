package eu.kanade.tachiyomi.extension.vi.doctruyen3q

import eu.kanade.tachiyomi.multisrc.wpcomics.WPComics
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.interceptor.rateLimit
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.Response
import org.jsoup.nodes.Element
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class DocTruyen3Q :
    WPComics(
        "DocTruyen3Q",
        "https://doctruyen3qui21.com",
        "vi",
        dateFormat = SimpleDateFormat("dd-MM-yyyy", Locale.ROOT).apply {
            timeZone = TimeZone.getTimeZone("Asia/Ho_Chi_Minh")
        },
        gmtOffset = null,
    ) {

    override val baseUrl: String
        get() = LINK_SOURCE_URL.trimEnd('/')

    private val resolvedBaseUrl by lazy { resolveBaseUrl() }

    override val client = super.client.newBuilder()
        .rateLimit(5)
        .build()

    override fun pageListParse(response: Response): List<Page> = response.asJsoup().select("div.page-chapter[id] img").mapIndexed { index, element ->
        val rawUrl = element.attr("abs:src").ifEmpty { element.attr("abs:data-src") }
        Page(index, response.request.url.toString(), rawUrl)
    }.distinctBy { it.imageUrl }

    override fun imageRequest(page: Page): Request {
        val referer = page.url.takeIf { it.isNotBlank() } ?: "${requestBaseUrl()}/"
        val imageHeaders = headers.newBuilder()
            .set("Referer", referer)
            .set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            .build()
        return GET(page.imageUrl!!, imageHeaders)
    }

    override fun popularMangaSelector() = "div.item-manga div.item"

    override fun popularMangaRequest(page: Int): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET("$currentBaseUrl/$popularPath" + if (page > 1) "?page=$page" else "", requestHeaders(currentBaseUrl))
    }

    override fun popularMangaParse(response: Response): MangasPage = parseMangaPageSafe(response, popularMangaSelector())

    override fun popularMangaFromElement(element: Element) = SManga.create().apply {
        val sel = element.selectFirst(MANGA_LINK_SELECTOR)
        sel?.absUrl("href")?.takeIf { it.isNotBlank() }?.let { setUrlWithoutDomain(it) }
        title = sel?.attr("title")
            ?.ifBlank { sel.text() }
            ?.ifBlank { element.selectFirst("img[alt]")?.attr("alt").orEmpty() }
            .orEmpty()
        thumbnail_url = element.selectFirst("img")?.let(::imageOrNull)
    }

    override fun searchMangaSelector() = popularMangaSelector()

    override fun searchMangaFromElement(element: Element) = popularMangaFromElement(element)

    override fun latestUpdatesParse(response: Response): MangasPage = parseMangaPageSafe(response, popularMangaSelector())

    override fun searchMangaParse(response: Response): MangasPage = parseMangaPageSafe(response, searchMangaSelector())

    private fun parseMangaPageSafe(response: Response, selector: String): MangasPage {
        val document = response.asJsoup()
        val mangas = document.select(selector)
            .mapNotNull(::mangaFromElementOrNull)
            .distinctBy { it.url }
        val hasNextPage = document.selectFirst("a.next-page, a[rel=next], .pagination a.active + a") != null
        return MangasPage(mangas, hasNextPage)
    }

    private fun mangaFromElementOrNull(element: Element): SManga? {
        val sel = element.selectFirst(MANGA_LINK_SELECTOR) ?: return null
        val href = sel.absUrl("href").takeIf { it.isNotBlank() } ?: return null
        val title = sel.attr("title")
            .ifBlank { sel.text() }
            .ifBlank { element.selectFirst("img[alt]")?.attr("alt").orEmpty() }
            .takeIf { it.isNotBlank() }
            ?: return null

        return SManga.create().apply {
            setUrlWithoutDomain(href)
            this.title = title
            thumbnail_url = element.selectFirst("img")?.let(::imageOrNull)
        }
    }

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        val currentBaseUrl = requestBaseUrl()
        val url = "$currentBaseUrl/$searchPath".toHttpUrl().newBuilder()

        filters.forEach { filter ->
            when (filter) {
                is GenreFilter -> filter.toUriPart()?.let { url.addPathSegment(it) }
                is StatusFilter -> filter.toUriPart()?.let { url.addQueryParameter("status", it) }
                else -> {}
            }
        }

        when {
            query.isNotBlank() -> url.addQueryParameter(queryParam, query)
            else -> url.addQueryParameter("page", page.toString())
        }

        return GET(url.toString(), requestHeaders(currentBaseUrl))
    }

    override fun latestUpdatesRequest(page: Int): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET(currentBaseUrl + if (page > 1) "?page=$page" else "", requestHeaders(currentBaseUrl))
    }

    override fun mangaDetailsRequest(manga: SManga): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET(currentBaseUrl + manga.url, requestHeaders(currentBaseUrl))
    }

    override fun mangaDetailsParse(response: Response) = SManga.create().apply {
        val document = response.asJsoup()
        title = document.selectFirst("h1.title-manga")?.text()
            ?.ifBlank { document.title().substringBefore("|").trim() }
            .orEmpty()
        description = document.select("p.detail-summary").joinToString { it.wholeText().trim() }
        status = document.selectFirst("li.status p.detail-info span")?.text().toStatus()
        genre = document.select("li.category p.detail-info a").joinToString { it.text() }
        thumbnail_url = document.selectFirst("img.image-comic, .col-image img")?.let(::imageOrNull)
            ?: document.selectFirst("meta[property=og:image]")?.attr("content")
    }

    override fun chapterListSelector() = "div.list-chapter li.row:not(.heading):not([style])"

    override fun chapterListRequest(manga: SManga): Request = mangaDetailsRequest(manga)

    override fun chapterFromElement(element: Element): SChapter = super.chapterFromElement(element).apply {
        date_upload = element.selectFirst(".chapters + div")?.text().toDate()
    }

    override val genresSelector = ".categories-detail ul.nav li:not(.active) a"

    override fun pageListRequest(chapter: SChapter): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET(currentBaseUrl + chapter.url, requestHeaders(currentBaseUrl))
    }

    protected override fun genresRequest(): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET("$currentBaseUrl/$searchPath", requestHeaders(currentBaseUrl))
    }

    private fun requestBaseUrl(): String = resolvedBaseUrl

    private fun resolveBaseUrl(): String = runCatching {
        network.client.newCall(GET(LINK_SOURCE_URL)).execute().use { response ->
            val redirectedUrl = response.request.url
            if (redirectedUrl.host == LINK_SOURCE_HOST) {
                throw IllegalStateException("Could not resolve DocTruyen3Q domain from $LINK_SOURCE_URL")
            }

            redirectedUrl.newBuilder()
                .encodedPath("/")
                .query(null)
                .fragment(null)
                .build()
                .toString()
                .trimEnd('/')
        }
    }.getOrThrow()

    private fun requestHeaders(currentBaseUrl: String) = headersBuilder()
        .set("Referer", "$currentBaseUrl/")
        .build()

    companion object {
        private const val MANGA_LINK_SELECTOR = "h3 a[href], a[href*=/truyen-tranh/]:not(.chapter):not(.slide-chap)"
        private const val LINK_SOURCE_URL = "https://doctruyen3qui21.com/"
        private const val LINK_SOURCE_HOST = "doctruyen3qui21.com"
    }
}
