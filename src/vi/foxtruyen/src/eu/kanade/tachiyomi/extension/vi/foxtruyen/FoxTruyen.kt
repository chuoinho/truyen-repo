package eu.kanade.tachiyomi.extension.vi.foxtruyen

import android.content.SharedPreferences
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.interceptor.rateLimit
import eu.kanade.tachiyomi.source.ConfigurableSource
import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.util.asJsoup
import keiyoushi.utils.getPreferences
import keiyoushi.utils.tryParse
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class FoxTruyen :
    HttpSource(),
    ConfigurableSource {

    override val name = "FoxTruyen"

    override val lang = "vi"

    private val defaultBaseUrl = "https://foxtruyen2.com"

    override val supportsLatest = true

    private val preferences: SharedPreferences = getPreferences()

    override val baseUrl: String
        get() = getOverrideBaseUrlOrNull() ?: defaultBaseUrl

    override val id: Long = 1458993267006200127

    override val client: OkHttpClient = network.cloudflareClient.newBuilder()
        .rateLimit(2)
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder().add("Referer", "$baseUrl/")

    private val dateFormat = SimpleDateFormat("dd/MM/yyyy", Locale.ROOT).apply {
        timeZone = TimeZone.getTimeZone("Asia/Ho_Chi_Minh")
    }

    private var genreList: List<Genre> = emptyList()

    private var fetchGenresAttempts = 0

    // Popular
    override fun popularMangaRequest(page: Int): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET("$currentBaseUrl/top-binh-chon" + if (page > 1) "/trang-$page.html" else "", headersFor(currentBaseUrl))
    }

    override fun popularMangaParse(response: Response): MangasPage = latestUpdatesParse(response)

    // Latest
    override fun latestUpdatesRequest(page: Int): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET("$currentBaseUrl/truyen-moi-cap-nhat" + if (page > 1) "/trang-$page.html" else "", headersFor(currentBaseUrl))
    }

    override fun latestUpdatesParse(response: Response): MangasPage {
        val document = response.asJsoup()
        val mangas = document.select(".list_item_home .item_home").mapNotNull { element ->
            val linkElement = element.selectFirst("a.book_name[href], a[href*=/truyen-tranh/]:not(.cl99)") ?: return@mapNotNull null
            val href = linkElement.absUrl("href").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val titleText = linkElement.attr("title")
                .ifBlank { linkElement.text() }
                .ifBlank { element.selectFirst("img[alt]")?.attr("alt").orEmpty() }
                .takeIf { it.isNotBlank() }
                ?: return@mapNotNull null

            SManga.create().apply {
                setUrlWithoutDomain(href)
                title = titleText
                thumbnail_url = element.selectFirst(".image-cover img")
                    ?.let { image ->
                        image.absUrl("data-src")
                            .ifBlank { image.absUrl("data-original") }
                            .ifBlank { image.absUrl("src") }
                    }
            }
        }
        val hasNextPage = document.selectFirst(".pagination a.active + a") != null
        return MangasPage(mangas, hasNextPage)
    }

    // Search
    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        val endpoint = if (query.isNotBlank()) "tim-kiem" else "tim-kiem-nang-cao"
        val currentBaseUrl = requestBaseUrl()
        val url = ("$currentBaseUrl/$endpoint" + if (page > 1) "/trang-$page.html" else "").toHttpUrl().newBuilder().apply {
            if (query.isNotBlank()) {
                addQueryParameter("q", query)
            } else {
                (filters.ifEmpty { getFilterList() }).forEach { filter ->
                    when (filter) {
                        is CountryFilter -> addQueryParameter("country", filter.values[filter.state].id)
                        is StatusFilter -> addQueryParameter("status", filter.values[filter.state].id)
                        is ChapterCountFilter -> addQueryParameter("minchapter", filter.values[filter.state].id)
                        is SortByFilter -> filter.state?.let {
                            addQueryParameter("sort", (it.index * 2 + if (it.ascending) 1 else 0).toString())
                        }
                        is GenreList -> {
                            addQueryParameter(
                                "category",
                                filter.state.filter { it.state == Filter.TriState.STATE_INCLUDE }
                                    .joinToString(",") { it.id },
                            )
                            addQueryParameter(
                                "notcategory",
                                filter.state.filter { it.state == Filter.TriState.STATE_EXCLUDE }
                                    .joinToString(",") { it.id },
                            )
                        }
                        else -> {}
                    }
                }
            }
        }.build()

        return GET(url, headersFor(currentBaseUrl))
    }

    override fun searchMangaParse(response: Response): MangasPage = latestUpdatesParse(response)

    override fun mangaDetailsRequest(manga: SManga): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET(currentBaseUrl + manga.url, headersFor(currentBaseUrl))
    }

    override fun chapterListRequest(manga: SManga): Request = mangaDetailsRequest(manga)

    override fun pageListRequest(chapter: SChapter): Request {
        val currentBaseUrl = requestBaseUrl()
        return GET(currentBaseUrl + chapter.url, headersFor(currentBaseUrl))
    }

    // Details
    override fun mangaDetailsParse(response: Response): SManga = SManga.create().apply {
        val document = response.asJsoup()
        title = document.select("h1[itemprop=name]").text()
        author = document.selectFirst("p:contains(Tác Giả) + p")?.text()
        genre = document.select("a.clblue").joinToString { it.text() }
        description = document.select("div.story-detail-info").joinToString {
            it.wholeText().trim()
        }
        thumbnail_url = document.selectFirst(".thumbblock img")?.absUrl("src")
        status = parseStatus(document.select("p:contains(Trạng Thái) + p").text())
    }

    private fun parseStatus(status: String?): Int {
        val ongoingWords = listOf("Đang Cập Nhật", "Đang Tiến Hành")
        val completedWords = listOf("Hoàn Thành", "Đã Hoàn Thành")
        val hiatusWords = listOf("Tạm ngưng", "Tạm hoãn")
        return when {
            status == null -> SManga.UNKNOWN
            ongoingWords.any { status.contains(it, ignoreCase = true) } -> SManga.ONGOING
            completedWords.any { status.contains(it, ignoreCase = true) } -> SManga.COMPLETED
            hiatusWords.any { status.contains(it, ignoreCase = true) } -> SManga.ON_HIATUS
            else -> SManga.UNKNOWN
        }
    }

    // Chapters
    override fun chapterListParse(response: Response): List<SChapter> {
        val document = response.asJsoup()
        return document.select("#fx-chap-list > li.fx-chap-item, ul.list_chap > li.item_chap").mapNotNull { element ->
            val linkElement = element.selectFirst("a[href]") ?: return@mapNotNull null
            val href = linkElement.absUrl("href").ifBlank { linkElement.attr("href") }
                .takeIf { it.isNotBlank() }
                ?: return@mapNotNull null

            SChapter.create().apply {
                setUrlWithoutDomain(href)
                name = linkElement.text()
                date_upload = dateFormat.tryParse(
                    element.selectFirst(".fx-chap-item__date, span.cl99")
                        ?.text()
                        ?.trim(),
                )
            }
        }
    }

    // Pages
    override fun pageListParse(response: Response): List<Page> {
        val document = response.asJsoup()
        return document.select(".content_detail img")
            .mapNotNull { img ->
                img.absUrl("data-src")
                    .ifBlank { img.absUrl("data-original") }
                    .ifBlank { img.absUrl("src") }
                    .takeIf { it.isNotBlank() }
            }
            .distinct()
            .mapIndexed { idx, imageUrl ->
                Page(idx, imageUrl = imageUrl)
            }
    }

    override fun imageUrlParse(response: Response) = throw UnsupportedOperationException()

    // Filters
    override fun getFilterList(): FilterList {
        fetchGenres()

        return FilterList(
            Filter.Header("Không dùng chung với tìm kiếm bằng tên"),
            CountryFilter(),
            StatusFilter(),
            ChapterCountFilter(),
            SortByFilter(),
            GenreList(genreList.ifEmpty { getGenreList() }),
        )
    }

    private fun fetchGenres() {
        if (genreList.isNotEmpty() || fetchGenresAttempts >= 3) return
        fetchGenresAttempts++

        runCatching {
            val currentBaseUrl = requestBaseUrl()
            client.newCall(GET("$currentBaseUrl/tim-kiem-nang-cao.html", headersFor(currentBaseUrl))).execute().use { response ->
                val document = response.asJsoup()
                val genres = document.select(".adv-genre-item[data-id]")
                    .mapNotNull { element ->
                        val id = element.attr("data-id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                        val name = element.ownText()
                            .ifBlank { element.text() }
                            .cleanGenreName()
                        if (name.isBlank()) null else Genre(name, id)
                    }
                    .ifEmpty {
                        document.select("a[href*=/the-loai/]")
                            .mapNotNull { element ->
                                val id = GENRE_ID_REGEX.find(element.attr("href"))
                                    ?.groupValues
                                    ?.getOrNull(1)
                                    ?: return@mapNotNull null
                                val name = element.attr("title")
                                    .ifBlank { element.text() }
                                    .cleanGenreName()
                                if (name.isBlank()) null else Genre(name, id)
                            }
                    }
                    .distinctBy { it.id }

                if (genres.isNotEmpty()) {
                    genreList = genres
                }
            }
        }
    }

    private fun String.cleanGenreName(): String = replace(WHITESPACE_REGEX, " ").trim()

    private class Genre(name: String, val id: String) : Filter.TriState(name) {
        override fun toString(): String = name
    }

    private class CountryFilter :
        Filter.Select<Genre>(
            "Quốc gia",
            arrayOf(
                Genre("Tất cả", "0"),
                Genre("Trung Quốc", "1"),
                Genre("Việt Nam", "2"),
                Genre("Hàn Quốc", "3"),
                Genre("Nhật Bản", "4"),
                Genre("Mỹ", "5"),
            ),
        )

    private class StatusFilter :
        Filter.Select<Genre>(
            "Tình trạng",
            arrayOf(
                Genre("Tất cả", "-1"),
                Genre("Đang tiến hành", "0"),
                Genre("Hoàn thành", "2"),
            ),
        )

    private class ChapterCountFilter :
        Filter.Select<Genre>(
            "Số lượng chương",
            arrayOf(
                Genre("0", "0"),
                Genre(">= 100", "100"),
                Genre(">= 200", "200"),
                Genre(">= 300", "300"),
                Genre(">= 400", "400"),
                Genre(">= 500", "500"),
            ),
        )

    private class SortByFilter :
        Filter.Sort(
            "Sắp xếp",
            arrayOf("Ngày đăng", "Ngày cập nhật", "Lượt xem"),
            Selection(1, false),
        )

    private class GenreList(state: List<Genre>) : Filter.Group<Genre>("Thể loại", state)

    private fun getGenreList() = listOf(
        Genre("Action", "37"),
        Genre("Adventure", "38"),
        Genre("Anime", "39"),
        Genre("Cổ Đại", "40"),
        Genre("Comedy", "41"),
        Genre("Comic", "42"),
        Genre("Detective", "43"),
        Genre("Doujinshi", "44"),
        Genre("Drama", "45"),
        Genre("Ecchi", "80"),
        Genre("Fantasy", "46"),
        Genre("Gender Bender", "47"),
        Genre("Harem", "78"),
        Genre("Historical", "48"),
        Genre("Horror", "49"),
        Genre("Huyền Huyễn", "50"),
        Genre("Isekai", "51"),
        Genre("Josei", "52"),
        Genre("Magic", "53"),
        Genre("Manga", "81"),
        Genre("Manhua", "54"),
        Genre("Manhwa", "55"),
        Genre("Martial Arts", "56"),
        Genre("Mystery", "57"),
        Genre("Ngôn Tình", "58"),
        Genre("One shot", "59"),
        Genre("Psychological", "60"),
        Genre("Romance", "61"),
        Genre("School Life", "62"),
        Genre("Sci-fi", "63"),
        Genre("Seinen", "64"),
        Genre("Shoujo", "65"),
        Genre("Shoujo Ai", "66"),
        Genre("Shounen", "67"),
        Genre("Shounen Ai", "68"),
        Genre("Slice of life", "69"),
        Genre("Sports", "70"),
        Genre("Supernatural", "71"),
        Genre("Tragedy", "72"),
        Genre("Truyện Màu", "73"),
        Genre("Webtoon", "74"),
        Genre("Xuyên Không", "75"),
        Genre("Yuri", "76"),
    )

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        EditTextPreference(screen.context).apply {
            key = BASE_URL_PREF
            title = BASE_URL_PREF_TITLE
            summary = BASE_URL_PREF_SUMMARY
            setDefaultValue(defaultBaseUrl)
            dialogTitle = BASE_URL_PREF_TITLE
            dialogMessage = "Default: $defaultBaseUrl"

            setOnPreferenceChangeListener { _, _ ->
                Toast.makeText(screen.context, RESTART_APP, Toast.LENGTH_LONG).show()
                true
            }
        }.let(screen::addPreference)
    }

    private fun requestBaseUrl(): String = getOverrideBaseUrlOrNull() ?: defaultBaseUrl

    private fun getOverrideBaseUrlOrNull(): String? = preferences.getString(BASE_URL_PREF, null)
        ?.trim()
        ?.trimEnd('/')
        ?.takeUnless { it.isBlank() || isGeneratedBaseUrl(it) }

    private fun headersFor(url: String): Headers = headersBuilder()
        .set("Referer", "$url/")
        .build()

    private fun isGeneratedBaseUrl(url: String): Boolean {
        if (url == defaultBaseUrl) return true
        return GENERATED_FOXTRUYEN_DOMAIN_REGEX.matches(url)
    }

    companion object {
        private val GENERATED_FOXTRUYEN_DOMAIN_REGEX = Regex("""https://foxtruyen\d*\.com""")
        private val GENRE_ID_REGEX = Regex("""-(\d+)(?:\.html)?/?$""")
        private val WHITESPACE_REGEX = Regex("\\s+")

        private const val RESTART_APP = "Khởi chạy lại ứng dụng để áp dụng thay đổi."
        private const val BASE_URL_PREF_TITLE = "Ghi đè URL cơ sở"
        private const val BASE_URL_PREF = "overrideBaseUrl"
        private const val BASE_URL_PREF_SUMMARY =
            "Dành cho sử dụng tạm thời, cập nhật tiện ích sẽ xóa cài đặt."
    }
}
