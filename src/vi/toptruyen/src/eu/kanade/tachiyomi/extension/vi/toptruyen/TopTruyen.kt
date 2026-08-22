package eu.kanade.tachiyomi.extension.vi.toptruyen

import android.content.SharedPreferences
import android.widget.Toast
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.multisrc.wpcomics.WPComics
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.interceptor.rateLimit
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.util.asJsoup
import keiyoushi.utils.getPreferences
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import okhttp3.Response
import org.jsoup.nodes.Element
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class TopTruyen :
    WPComics(
        "Top Truyen",
        "https://toptruyen279.online",
        "vi",
        dateFormat = SimpleDateFormat("dd-MM-yyyy", Locale.ROOT).apply {
            timeZone = TimeZone.getTimeZone("Asia/Ho_Chi_Minh")
        },
        gmtOffset = null,
    ),
    ConfigurableSource {

    override fun pageListParse(response: Response): List<Page> {
        val document = response.asJsoup()
        val imageElements = document.select("div[id^=page_].page-chapter img").ifEmpty {
            document.select(
                "div.list-image-detail img[src*=/image_comics/], " +
                    "div.list-image-detail img[data-src*=/image_comics/], " +
                    "div.list-image-detail img[data-original*=/image_comics/]",
            )
        }

        return imageElements.mapNotNull { imageOrNull(it) }
            .distinct()
            .mapIndexed { index, image -> Page(index, imageUrl = image) }
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
        date_upload = element.select(".chapters + div").text().toDate()
    }

    override val genresSelector = ".categories-detail ul.nav li:not(.active) a"

    override fun pageListRequest(chapter: SChapter): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET(currentBaseUrl + chapter.url, requestHeaders(currentBaseUrl))
    }

    override fun imageRequest(page: Page): Request {
        val currentBaseUrl = requestBaseUrl()
        val imageHeaders = requestHeaders(currentBaseUrl).newBuilder()
            .set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
            .build()
        return GET(page.imageUrl!!, imageHeaders)
    }

    protected override fun genresRequest(): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET("$currentBaseUrl/$searchPath", requestHeaders(currentBaseUrl))
    }

    // Configurable, automatic domain resolution
    private val preferences: SharedPreferences = getPreferences()
    private val resolvedBaseUrl by lazy { resolveBaseUrl() }

    override val client = super.client.newBuilder()
        .rateLimit(5)
        .build()

    override val baseUrl: String
        get() = getOverrideBaseUrlOrNull() ?: REDIRECT_URL

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val defaultUrl = REDIRECT_URL
        val baseUrlPref = androidx.preference.EditTextPreference(screen.context).apply {
            key = BASE_URL_PREF
            title = BASE_URL_PREF_TITLE
            summary = BASE_URL_PREF_SUMMARY
            setDefaultValue(defaultUrl)
            dialogTitle = BASE_URL_PREF_TITLE
            dialogMessage = "Default: $defaultUrl"
            setOnPreferenceChangeListener { _, _ ->
                Toast.makeText(screen.context, RESTART_APP, Toast.LENGTH_LONG).show()
                true
            }
        }
        screen.addPreference(baseUrlPref)
    }

    private fun requestBaseUrl(): String = getOverrideBaseUrlOrNull() ?: resolvedBaseUrl

    private fun getOverrideBaseUrlOrNull(): String? = preferences.getString(BASE_URL_PREF, null)
        ?.trim()
        ?.trimEnd('/')
        ?.takeUnless { it.isBlank() || isGeneratedBaseUrl(it) }

    private fun isGeneratedBaseUrl(url: String): Boolean {
        if (url == REDIRECT_URL) return true
        return GENERATED_TOPTRUYEN_DOMAIN_REGEX.matches(url)
    }

    private fun resolveBaseUrl(): String = runCatching {
        network.client.newCall(GET(REDIRECT_URL, requestHeaders(REDIRECT_URL))).execute().use { response ->
            val redirectedUrl = response.request.url
            if (redirectedUrl.host == REDIRECT_HOST || redirectedUrl.host == "www.$REDIRECT_HOST") {
                throw IllegalStateException("Could not resolve TopTruyen domain from $REDIRECT_URL")
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
        private const val REDIRECT_URL = "https://toptruyen279.online"
        private const val REDIRECT_HOST = "toptruyen279.online"
        private val GENERATED_TOPTRUYEN_DOMAIN_REGEX = Regex("""https://(?:www\.)?toptruyenzone\d+\.com""")
        private const val RESTART_APP = "Khởi chạy lại ứng dụng để áp dụng thay đổi."
        private const val BASE_URL_PREF_TITLE = "Ghi đè URL cơ sở"
        private const val BASE_URL_PREF = "overrideBaseUrl"
        private const val BASE_URL_PREF_SUMMARY =
            "Dành cho sử dụng tạm thời, cập nhật tiện ích sẽ xóa cài đặt."
    }
}
