// 外部の地図タイルのURL定数
const constTileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
// 天気APIのベースURL定数
const constWeatherApiUrl = 'https://api.open-meteo.com/v1/forecast';
// 地球の半径（km）
const constEarthRadiusKm = 6371;
// 設定をローカルストレージに保存するためのキー定数
const constSettingsStorageKey = 'gpxWeatherAppSettings';
// レイアウトを保存するためのキー定数
const constLayoutStorageKey = 'gpxWeatherAppLayout';

// ラジオボタンの値を設定するヘルパー関数
function SetRadioValue(name, value) {
    const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (el) {
        el.checked = true;
    }
}

// ラジオボタンの値を取得するヘルパー関数
function GetRadioValue(name) {
    const el = document.querySelector(`input[name="${name}"]:checked`);
    return el ? el.value : '';
}

// FitParserから得られるSemicircles形式の座標を度数に変換する補助関数
function NormalizeDegree(val) {
    const isOutOfRange = Math.abs(val) > 180;
    if (isOutOfRange) {
        return val * (180 / Math.pow(2, 31));
    }
    return val;
}

// KML文字列からポイント配列を抽出する関数
function ParseKml(kmlString) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(kmlString, "text/xml");
    const points = [];

    // gx:Track (ログデータ等) を探索
    const tracks = xmlDoc.getElementsByTagNameNS("*", "Track");
    if (tracks.length > 0) {
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            const whens = track.getElementsByTagNameNS("*", "when");
            const coords = track.getElementsByTagNameNS("*", "coord");
            
            for (let j = 0; j < coords.length; j++) {
                const coordText = coords[j].textContent.trim().split(/\s+/);
                if (coordText.length >= 2) {
                    const lon = parseFloat(coordText[0]);
                    const lat = parseFloat(coordText[1]);
                    const ele = coordText.length >= 3 ? parseFloat(coordText[2]) : 0;
                    let time = null;
                    if (whens[j]) {
                        time = new Date(whens[j].textContent);
                    }
                    points.push({ lat: lat, lng: lon, ele: ele, time: time, estimatedTime: null, totalDistance: 0, calculatedSpeed: 0 });
                }
            }
        }
        if (points.length > 0) return points;
    }

    // LineString (ルートデータ) を探索
    const lineStrings = xmlDoc.getElementsByTagNameNS("*", "LineString");
    if (lineStrings.length > 0) {
        for (let i = 0; i < lineStrings.length; i++) {
            const coordsNode = lineStrings[i].getElementsByTagNameNS("*", "coordinates");
            if (coordsNode.length > 0) {
                const coordsText = coordsNode[0].textContent.trim().split(/\s+/);
                for (let j = 0; j < coordsText.length; j++) {
                    const pt = coordsText[j].split(',');
                    if (pt.length >= 2) {
                        const lon = parseFloat(pt[0]);
                        const lat = parseFloat(pt[1]);
                        const ele = pt.length >= 3 ? parseFloat(pt[2]) : 0;
                        points.push({ lat: lat, lng: lon, ele: ele, time: null, estimatedTime: null, totalDistance: 0, calculatedSpeed: 0 });
                    }
                }
            }
        }
    }
    
    return points;
}

// KMZ(ZIP)データを解凍し、内部のKMLからポイント配列を抽出する非同期関数
async function ParseKmz(buffer) {
    if (!window.JSZip) {
        throw new Error("JSZipライブラリが読み込まれていません。");
    }
    const zip = new window.JSZip();
    const contents = await zip.loadAsync(buffer);
    for (const filename in contents.files) {
        if (filename.toLowerCase().endsWith('.kml')) {
            const kmlText = await contents.files[filename].async("text");
            return ParseKml(kmlText);
        }
    }
    throw new Error("KMZファイル内にKMLファイルが見つかりませんでした。");
}

// FITファイルのArrayBufferからポイント配列を抽出する非同期関数
async function ParseFit(buffer) {
    let FitParser;
    try {
        const module = await import('https://esm.sh/fit-file-parser');
        FitParser = module.default;
    } catch (error) {
        throw new Error("FIT解析モジュールの読み込みに失敗しました。");
    }

    return new Promise((resolve, reject) => {
        const fitParser = new FitParser({
            force: true,
            speedUnit: 'km/h',
            lengthUnit: 'km',
            temperatureUnit: 'celcius',
        });
        
        fitParser.parse(buffer, (error, data) => {
            if (error || !data || !data.records) {
                reject(error || new Error("無効なFITデータです。"));
                return;
            }
            
            const points = [];
            const records = data.records;
            for (let i = 0; i < records.length; i++) {
                const record = records[i];
                if (record.position_lat !== undefined && record.position_long !== undefined) {
                    const lat = NormalizeDegree(record.position_lat);
                    const lon = NormalizeDegree(record.position_long);
                    const ele = record.altitude !== undefined ? record.altitude : 0;
                    const time = record.timestamp ? new Date(record.timestamp) : null;
                    points.push({ lat: lat, lng: lon, ele: ele, time: time, estimatedTime: null, totalDistance: 0, calculatedSpeed: 0 });
                }
            }
            resolve(points);
        });
    });
}

// GPX文字列からポイント配列を抽出する関数
function ParseGpx(gpxString) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(gpxString, "text/xml");
    
    let trackPoints = xmlDoc.getElementsByTagNameNS("*", "trkpt");
    
    const trkptExists = trackPoints.length > 0;
    if (!trkptExists) {
        trackPoints = xmlDoc.getElementsByTagNameNS("*", "rtept");
    }
    
    const rteptExists = trackPoints.length > 0;
    if (!rteptExists) {
        trackPoints = xmlDoc.getElementsByTagNameNS("*", "wpt");
    }

    const points = [];
    const trackPointsExists = trackPoints.length > 0;
    if (!trackPointsExists) {
        return points;
    }

    for (let i = 0; i < trackPoints.length; i++) {
        const lat = parseFloat(trackPoints[i].getAttribute("lat"));
        const lon = parseFloat(trackPoints[i].getAttribute("lon"));
        
        let ele = 0;
        const eleNodes = trackPoints[i].getElementsByTagNameNS("*", "ele");
        const eleExists = eleNodes.length > 0;
        if (eleExists) {
            ele = parseFloat(eleNodes[0].textContent);
        }

        let time = null;
        const timeNodes = trackPoints[i].getElementsByTagNameNS("*", "time");
        const timeExists = timeNodes.length > 0;
        if (timeExists) {
            time = new Date(timeNodes[0].textContent);
        }

        points.push({ lat: lat, lng: lon, ele: ele, time: time, estimatedTime: null, totalDistance: 0, calculatedSpeed: 0 });
    }
    
    return points;
}

// アプリケーション全体を管理するクラス
class APP_MANAGER {
    constructor() {
        this.mapInstance = null;
        this.routeLayer = null;
        this.weatherMarkers = [];
        this.hasRouteData = false;
        this.currentRoutePoints = [];
        this.currentAbortController = null;
        this.weatherDataCache = [];
        this.currentLocation = null;
        this.chartInstance = null;
        this.hoverMarker = null;
        this.grid = null;
    }

    // 地図の初期化と設定の読み込みを行うメソッド
    InitializeApp() {
        // GridStack の初期化
        this.grid = GridStack.init({
            cellHeight: 80,
            margin: 5,
            handle: '.drag-handle',
            float: false
        });

        // 保存されたレイアウト設定があれば復元
        const savedLayout = localStorage.getItem(constLayoutStorageKey);
        if (savedLayout) {
            try {
                const layoutData = JSON.parse(savedLayout);
                layoutData.forEach(item => {
                    const widgetEl = document.querySelector(`[gs-id="${item.id}"]`);
                    if (widgetEl) {
                        this.grid.update(widgetEl, { x: item.x, y: item.y, w: item.w, h: item.h });
                    }
                });
            } catch (e) {
                console.warn("レイアウトの復元に失敗しました:", e);
            }
        }

        // レイアウト変更時に自動保存
        this.grid.on('change', () => {
            const currentLayout = this.grid.save().map(item => ({
                id: item.id,
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h
            }));
            localStorage.setItem(constLayoutStorageKey, JSON.stringify(currentLayout));
        });

        this.mapInstance = L.map('map').setView([35.6895, 139.6917], 10);
        L.tileLayer(constTileUrl, {
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(this.mapInstance);

        // 地図上の設定コントロールおよび凡例のイベント伝播を無効化
        const markerControl = document.getElementById('markerDisplayControl');
        const hasMarkerControl = markerControl !== null;
        if (hasMarkerControl) {
            L.DomEvent.disableClickPropagation(markerControl);
            L.DomEvent.disableScrollPropagation(markerControl);
        }

        const legendControl = document.querySelector('.route-legend');
        const hasLegendControl = legendControl !== null;
        if (hasLegendControl) {
            L.DomEvent.disableClickPropagation(legendControl);
            L.DomEvent.disableScrollPropagation(legendControl);
        }

        // リサイズ時の再描画処理（ResizeObserver）
        const mapResizeObserver = new ResizeObserver(() => {
            if (this.mapInstance) {
                this.mapInstance.invalidateSize();
            }
        });
        const mapElement = document.getElementById('map');
        if (mapElement) {
            mapResizeObserver.observe(mapElement);
        }

        const chartResizeObserver = new ResizeObserver(() => {
            if (this.chartInstance) {
                this.chartInstance.resize();
            }
        });
        const canvasWrapper = document.querySelector('.canvas-wrapper');
        if (canvasWrapper) {
            chartResizeObserver.observe(canvasWrapper);
        }

        this.LoadSettings();
        this.AttachEventListeners();
        this.AttachModalListeners();
    }

    // ローカルストレージから設定を読み込むメソッド
    LoadSettings() {
        const savedData = localStorage.getItem(constSettingsStorageKey);
        const hasSavedData = savedData !== null;

        if (hasSavedData) {
            const settings = JSON.parse(savedData);
            
            if (settings.themeMode !== undefined) {
                const themeToggleExists = document.getElementById('themeToggleCb') !== null;
                if (themeToggleExists) {
                    document.getElementById('themeToggleCb').checked = settings.themeMode === 'dark';
                }
            }
            
            if (settings.appMode !== undefined) {
                SetRadioValue('appMode', settings.appMode);
            }

            if (settings.speedMode !== undefined) {
                SetRadioValue('speedMode', settings.speedMode);
            }

            const hasStartTime = settings.startTime !== undefined && settings.startTime !== "";
            if (hasStartTime) {
                document.getElementById('inputStartTime').value = settings.startTime;
            } else {
                this.SetCurrentTime();
            }

            // 手動設定（3段階）の読み込み
            if (settings.climbSpeedManual !== undefined) document.getElementById('inputClimbSpeedManual').value = settings.climbSpeedManual;
            if (settings.flatSpeedManual !== undefined) document.getElementById('inputFlatSpeedManual').value = settings.flatSpeedManual;
            if (settings.descendSpeedManual !== undefined) document.getElementById('inputDescendSpeedManual').value = settings.descendSpeedManual;

            // 過去ログ算出（7段階）の速度設定を読み込み
            if (settings.extremeClimbSpeed !== undefined) document.getElementById('inputExtremeClimbSpeed').value = settings.extremeClimbSpeed;
            if (settings.steepClimbSpeed !== undefined) document.getElementById('inputSteepClimbSpeed').value = settings.steepClimbSpeed;
            if (settings.climbSpeed !== undefined) document.getElementById('inputClimbSpeed').value = settings.climbSpeed;
            if (settings.flatSpeed !== undefined) document.getElementById('inputFlatSpeed').value = settings.flatSpeed;
            if (settings.descendSpeed !== undefined) document.getElementById('inputDescendSpeed').value = settings.descendSpeed;
            if (settings.steepDescendSpeed !== undefined) document.getElementById('inputSteepDescendSpeed').value = settings.steepDescendSpeed;
            if (settings.extremeDescendSpeed !== undefined) document.getElementById('inputExtremeDescendSpeed').value = settings.extremeDescendSpeed;

            if (settings.fetchMethod !== undefined) {
                document.getElementById('inputFetchMethod').value = settings.fetchMethod;
            }
            if (settings.pointCount !== undefined) {
                document.getElementById('inputPointCount').value = settings.pointCount;
            }
            if (settings.timeInterval !== undefined) {
                document.getElementById('inputTimeInterval').value = settings.timeInterval;
            }
            if (settings.gradientSpan !== undefined) {
                document.getElementById('inputGradientSpan').value = settings.gradientSpan;
            }
            if (settings.markerDisplayMode !== undefined) {
                document.getElementById('inputMarkerDisplayMode').value = settings.markerDisplayMode;
            }
        } else {
            this.SetCurrentTime();
        }
        
        this.ApplyTheme();
        this.ToggleAppModeUI();
        this.ToggleSpeedModeUI();
        this.ToggleFetchMethodUI();
    }

    // テーマ設定を画面に適用するメソッド
    ApplyTheme() {
        const themeElement = document.getElementById('themeToggleCb');
        const themeElementExists = themeElement !== null;
        if (themeElementExists) {
            const isDark = themeElement.checked;
            if (isDark) {
                document.body.classList.add('dark-mode');
            } else {
                document.body.classList.remove('dark-mode');
            }
        }
    }

    // 動作モードの選択に応じてスタート日時の表示を切り替えるメソッド
    ToggleAppModeUI() {
        const appMode = GetRadioValue('appMode');
        const isNavMode = appMode === 'nav';
        
        const groupStartTime = document.getElementById('groupStartTime');
        if (isNavMode) {
            groupStartTime.style.display = 'none';
        } else {
            groupStartTime.style.display = 'flex';
        }
    }

    // 速度設定モードの選択に応じて入力フォーム群の表示を切り替えるメソッド
    ToggleSpeedModeUI() {
        const speedMode = GetRadioValue('speedMode');
        const groupManual = document.getElementById('groupManualSpeed');
        const groupAuto = document.getElementById('groupAutoSpeed');
        
        if (speedMode === 'manual') {
            groupManual.style.display = 'flex';
            groupAuto.style.display = 'none';
        } else {
            groupManual.style.display = 'none';
            groupAuto.style.display = 'flex';
        }
    }

    // 天気取得方法の選択に応じて入力フォームの表示を切り替えるメソッド
    ToggleFetchMethodUI() {
        const fetchMethod = document.getElementById('inputFetchMethod').value;
        const isPointCount = fetchMethod === 'pointCount';
        
        const groupPointCount = document.getElementById('groupPointCount');
        const groupTimeInterval = document.getElementById('groupTimeInterval');
        
        if (isPointCount) {
            groupPointCount.style.display = 'flex';
            groupTimeInterval.style.display = 'none';
        } else {
            groupPointCount.style.display = 'none';
            groupTimeInterval.style.display = 'flex';
        }
    }

    // 現在時刻をローカルタイムゾーンに合わせてフォームに設定するメソッド
    SetCurrentTime() {
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        const nowFormatted = now.toISOString().slice(0, 16);
        document.getElementById('inputStartTime').value = nowFormatted;
    }

    // 現在の入力フォームの値をローカルストレージに保存するメソッド
    SaveSettings() {
        const isDark = document.getElementById('themeToggleCb') !== null ? document.getElementById('themeToggleCb').checked : false;
        const settings = {
            themeMode: isDark ? 'dark' : 'light',
            appMode: GetRadioValue('appMode'),
            speedMode: GetRadioValue('speedMode'),
            startTime: document.getElementById('inputStartTime').value,
            
            climbSpeedManual: document.getElementById('inputClimbSpeedManual').value,
            flatSpeedManual: document.getElementById('inputFlatSpeedManual').value,
            descendSpeedManual: document.getElementById('inputDescendSpeedManual').value,
            
            extremeClimbSpeed: document.getElementById('inputExtremeClimbSpeed').value,
            steepClimbSpeed: document.getElementById('inputSteepClimbSpeed').value,
            climbSpeed: document.getElementById('inputClimbSpeed').value,
            flatSpeed: document.getElementById('inputFlatSpeed').value,
            descendSpeed: document.getElementById('inputDescendSpeed').value,
            steepDescendSpeed: document.getElementById('inputSteepDescendSpeed').value,
            extremeDescendSpeed: document.getElementById('inputExtremeDescendSpeed').value,
            
            fetchMethod: document.getElementById('inputFetchMethod').value,
            pointCount: document.getElementById('inputPointCount').value,
            timeInterval: document.getElementById('inputTimeInterval').value,
            gradientSpan: document.getElementById('inputGradientSpan').value,
            markerDisplayMode: document.getElementById('inputMarkerDisplayMode').value
        };
        localStorage.setItem(constSettingsStorageKey, JSON.stringify(settings));
    }

    // グラフのツールチップとアクティブポイントをプログラムから同期するメソッド
    SyncChartHover(pointIndex) {
        if (!this.chartInstance) return;

        if (pointIndex >= 0 && pointIndex < this.currentRoutePoints.length) {
            this.chartInstance.setActiveElements([
                { datasetIndex: 0, index: pointIndex }
            ]);
            this.chartInstance.tooltip.setActiveElements([
                { datasetIndex: 0, index: pointIndex }
            ], {
                x: this.chartInstance.scales.x.getPixelForValue(this.currentRoutePoints[pointIndex].totalDistance),
                y: this.chartInstance.scales['y-ele'].getPixelForValue(this.currentRoutePoints[pointIndex].ele)
            });
            this.chartInstance.update();
        } else {
            this.chartInstance.setActiveElements([]);
            this.chartInstance.tooltip.setActiveElements([], { x: 0, y: 0 });
            this.chartInstance.update();
        }
    }

    // 入力フォームの値が変更された際に自動保存し、表示を更新するイベントを設定するメソッド
    AttachEventListeners() {
        // ラジオボタンのイベント設定
        const radioNames = ['appMode', 'speedMode'];
        for (let i = 0; i < radioNames.length; i++) {
            const radios = document.querySelectorAll(`input[name="${radioNames[i]}"]`);
            for (let j = 0; j < radios.length; j++) {
                radios[j].addEventListener('change', () => {
                    this.SaveSettings();
                    if (radioNames[i] === 'appMode') this.ToggleAppModeUI();
                    if (radioNames[i] === 'speedMode') this.ToggleSpeedModeUI();
                    
                    if (this.hasRouteData) {
                        this.UpdateDisplay();
                    }
                });
            }
        }

        // 通常のinput/select要素のイベント設定
        const inputIds = [
            'themeToggleCb', 'inputStartTime', 
            'inputClimbSpeedManual', 'inputFlatSpeedManual', 'inputDescendSpeedManual',
            'inputExtremeClimbSpeed', 'inputSteepClimbSpeed', 'inputClimbSpeed', 
            'inputFlatSpeed', 'inputDescendSpeed', 'inputSteepDescendSpeed', 'inputExtremeDescendSpeed',
            'inputFetchMethod', 'inputPointCount', 
            'inputTimeInterval', 'inputGradientSpan', 'inputMarkerDisplayMode'
        ];
        
        for (let i = 0; i < inputIds.length; i++) {
            const element = document.getElementById(inputIds[i]);
            const elementExists = element !== null;
            if (elementExists) {
                const isMarkerModeInput = inputIds[i] === 'inputMarkerDisplayMode';
                const isThemeModeInput = inputIds[i] === 'themeToggleCb';
                
                element.addEventListener('change', () => {
                    this.SaveSettings();
                    
                    if (isThemeModeInput) {
                        this.ApplyTheme();
                    }
                    
                    if (this.hasRouteData) {
                        if (isMarkerModeInput || isThemeModeInput) {
                            this.RedrawMarkersOnly();
                            if (isThemeModeInput) {
                                this.DrawChart(this.currentRoutePoints);
                            }
                        } else {
                            this.UpdateDisplay();
                        }
                    }
                });
            }
        }

        const fetchMethodElement = document.getElementById('inputFetchMethod');
        const hasFetchMethodElement = fetchMethodElement !== null;
        if (hasFetchMethodElement) {
            fetchMethodElement.addEventListener('change', () => this.ToggleFetchMethodUI());
        }

        // 過去ログファイルが選択されたら自動で算出処理を走らせる
        const logFileInput = document.getElementById('logFileInput');
        const hasLogFileInput = logFileInput !== null;
        if (hasLogFileInput) {
            logFileInput.addEventListener('change', (event) => {
                const hasSelectedFiles = event.target.files.length > 0;
                if (hasSelectedFiles) {
                    this.ProcessLogFiles(event.target.files);
                }
            });
        }

        // 天気リスト上をホバーした際のグラフ連携
        const weatherTable = document.querySelector('.weather-table');
        const hasWeatherTable = weatherTable !== null;
        if (hasWeatherTable) {
            let lastHoveredCol = -1;
            
            weatherTable.addEventListener('mouseover', (e) => {
                const td = e.target.closest('td');
                if (!td) return;
                
                const colIndex = td.cellIndex;
                const isNewColumn = colIndex > 0 && colIndex !== lastHoveredCol;
                
                if (isNewColumn) {
                    lastHoveredCol = colIndex;
                    const weatherIdx = colIndex - 1;
                    
                    if (this.weatherDataCache && this.weatherDataCache[weatherIdx]) {
                        const weatherData = this.weatherDataCache[weatherIdx];
                        
                        let closestPointIdx = -1;
                        let minDiff = Infinity;
                        for (let i = 0; i < this.currentRoutePoints.length; i++) {
                            const diff = Math.abs(this.currentRoutePoints[i].totalDistance - weatherData.totalDistance);
                            if (diff < minDiff) {
                                minDiff = diff;
                                closestPointIdx = i;
                            }
                        }
                        
                        // リストホバー時はグラフのみ●表示
                        this.SyncChartHover(closestPointIdx);
                    }
                }
            });

            weatherTable.addEventListener('mouseout', (e) => {
                const related = e.relatedTarget;
                const isOutsideTable = !weatherTable.contains(related);
                if (isOutsideTable) {
                    lastHoveredCol = -1;
                    this.SyncChartHover(-1);
                }
            });
        }
    }

    // モーダルウィンドウの開閉イベントを設定するメソッド
    AttachModalListeners() {
        const linkTerms = document.getElementById('linkTerms');
        const linkPrivacy = document.getElementById('linkPrivacy');
        const modal = document.getElementById('documentModal');
        const modalBody = document.getElementById('modalBody');
        const closeBtn = document.getElementById('modalCloseBtn');
        const templateTerms = document.getElementById('templateTerms');
        const templatePrivacy = document.getElementById('templatePrivacy');

        const OpenModal = (template) => {
            modalBody.innerHTML = template.innerHTML;
            modal.style.display = 'flex';
        };

        if (linkTerms && templateTerms) {
            linkTerms.addEventListener('click', (e) => {
                e.preventDefault();
                OpenModal(templateTerms);
            });
        }

        if (linkPrivacy && templatePrivacy) {
            linkPrivacy.addEventListener('click', (e) => {
                e.preventDefault();
                OpenModal(templatePrivacy);
            });
        }

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                modalBody.innerHTML = '';
            });
        }

        if (modal) {
            modal.addEventListener('click', (e) => {
                const isOverlayClick = e.target === modal;
                if (isOverlayClick) {
                    modal.style.display = 'none';
                    modalBody.innerHTML = '';
                }
            });
        }
    }

    // 天気リストの指定したインデックスの列をハイライトし、必要に応じてスクロールするメソッド
    HighlightTableColumn(targetIndex) {
        const rowIds = ['row-point', 'row-distance', 'row-date', 'row-time', 'row-weather', 'row-precip', 'row-temp', 'row-wind', 'row-heading'];
        
        let targetCell = null;

        for (let r = 0; r < rowIds.length; r++) {
            const row = document.getElementById(rowIds[r]);
            const rowExists = row !== null;
            if (!rowExists) continue;
            
            // 全てのハイライトをクリア
            for (let i = 1; i < row.children.length; i++) {
                row.children[i].classList.remove('highlight-col');
            }
            
            // 指定されたインデックスの列をハイライト
            const isTargetValid = targetIndex >= 0 && targetIndex + 1 < row.children.length;
            if (isTargetValid) {
                row.children[targetIndex + 1].classList.add('highlight-col');
                if (r === 0) { // 基準とするセルを記録
                    targetCell = row.children[targetIndex + 1];
                }
            }
        }

        // ハイライトされた列が画面内に見えるように横スクロールを同期
        if (targetCell) {
            const wrapper = document.querySelector('.weather-table-wrapper');
            const hasWrapper = wrapper !== null;
            if (hasWrapper) {
                const wrapperRect = wrapper.getBoundingClientRect();
                const cellRect = targetCell.getBoundingClientRect();

                const isOutsideLeft = cellRect.left < wrapperRect.left;
                const isOutsideRight = cellRect.right > wrapperRect.right;

                if (isOutsideLeft || isOutsideRight) {
                    const scrollAmount = targetCell.offsetLeft - (wrapper.offsetWidth / 2) + (targetCell.offsetWidth / 2);
                    wrapper.scrollTo({ left: scrollAmount, behavior: 'auto' });
                }
            }
        }
    }

    // 既存の描画データとリスト（タイムライン表）およびキャッシュを削除するメソッド
    ClearMapAndList() {
        const routeLayerExists = this.routeLayer !== null;
        if (routeLayerExists) {
            this.mapInstance.removeLayer(this.routeLayer);
            this.routeLayer = null;
        }
        
        const hasMarkers = this.weatherMarkers.length > 0;
        if (hasMarkers) {
            for (let i = 0; i < this.weatherMarkers.length; i++) {
                this.mapInstance.removeLayer(this.weatherMarkers[i]);
            }
            this.weatherMarkers = [];
        }

        if (this.hoverMarker) {
            this.mapInstance.removeLayer(this.hoverMarker);
            this.hoverMarker = null;
        }

        this.weatherDataCache = [];

        if (this.chartInstance) {
            this.chartInstance.destroy();
            this.chartInstance = null;
        }

        const rowIds = ['row-point', 'row-distance', 'row-date', 'row-time', 'row-weather', 'row-precip', 'row-temp', 'row-wind', 'row-heading'];
        for (let i = 0; i < rowIds.length; i++) {
            const row = document.getElementById(rowIds[i]);
            const rowExists = row !== null;
            if (rowExists) {
                const childrenCount = row.children.length;
                for (let j = childrenCount - 1; j > 0; j--) {
                    row.removeChild(row.children[j]);
                }
            }
        }
    }

    // キャッシュされた天気データを用いてマーカーのみを再描画するメソッド
    RedrawMarkersOnly() {
        const markerDisplayMode = document.getElementById('inputMarkerDisplayMode').value;
        const isNoneMode = markerDisplayMode === 'none';

        const hasMarkers = this.weatherMarkers.length > 0;
        if (hasMarkers) {
            for (let i = 0; i < this.weatherMarkers.length; i++) {
                this.mapInstance.removeLayer(this.weatherMarkers[i]);
            }
            this.weatherMarkers = [];
        }

        const appMode = GetRadioValue('appMode');
        const isNavMode = appMode === 'nav';
        if (isNavMode) {
            const hasCurrentLocation = this.currentLocation !== null;
            if (hasCurrentLocation) {
                const currentLocMarker = L.circleMarker([this.currentLocation.lat, this.currentLocation.lng], {
                    radius: 8,
                    fillColor: "#e74c3c",
                    color: "#ffffff",
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 1
                }).addTo(this.mapInstance).bindPopup("<div style='font-size:14px;font-weight:bold;'>現在地</div>");
                this.weatherMarkers.push(currentLocMarker);
            }
        }

        if (isNoneMode) {
            return;
        }

        const hasCache = this.weatherDataCache.length > 0;
        if (hasCache) {
            for (let i = 0; i < this.weatherDataCache.length; i++) {
                const data = this.weatherDataCache[i];
                const marker = L.marker([data.lat, data.lng], { 
                    icon: CreateCustomIcon(data.pointLabelStr, data.timeString, data.weatherEmoji, data.windDirection, data.windSpeed, markerDisplayMode, data.heading, data.headingStr) 
                }).addTo(this.mapInstance).bindPopup(data.popupContent);
                 
                this.weatherMarkers.push(marker);
            }
        }
    }

    // 標高グラフと天気ピン・風向風速を描画し、マウスホバー連携を行うメソッド
    DrawChart(points) {
        const canvas = document.getElementById('elevationSpeedChart');
        if (!canvas) return;

        if (this.chartInstance) {
            this.chartInstance.destroy();
        }

        if (!points || points.length === 0) return;

        const eleData = [];
        let maxEle = 0;

        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            eleData.push({ x: p.totalDistance, y: p.ele });
            if (p.ele > maxEle) {
                maxEle = p.ele;
            }
        }

        // 天気アイコンと風向矢印を描画するために天井に十分な余裕を持たせる
        const suggestedMaxEle = Math.max(100, maxEle * 1.5);

        const isDarkMode = document.body.classList.contains('dark-mode');
        const textColor = isDarkMode ? '#e0e0e0' : '#333333';
        const gridColor = isDarkMode ? '#444444' : '#e0e0e0';

        // グラフ描画後に天気アイコンと相対風向・風速を描画するカスタムプラグイン
        const weatherData = this.weatherDataCache;
        const weatherPinPlugin = {
            id: 'weatherPinPlugin',
            afterDraw: (chart) => {
                if (!weatherData || weatherData.length === 0) return;
                
                const ctx = chart.ctx;
                const xAxis = chart.scales.x;
                const chartArea = chart.chartArea;

                ctx.save();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                weatherData.forEach(data => {
                    if (data.totalDistance === undefined) return;
                    
                    const xPixel = xAxis.getPixelForValue(data.totalDistance);
                    
                    // チャートの表示範囲外であれば描画をスキップ
                    if (xPixel < chartArea.left || xPixel > chartArea.right) return;

                    // 描画の基準高さ（上端から少し下）
                    const yTop = chartArea.top + 15;

                    // ピン（点線）の描画
                    ctx.beginPath();
                    ctx.moveTo(xPixel, yTop + 35);
                    ctx.lineTo(xPixel, chartArea.bottom);
                    ctx.lineWidth = 1;
                    ctx.strokeStyle = isDarkMode ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)';
                    ctx.setLineDash([4, 4]);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    // 天気アイコン（絵文字）の描画
                    ctx.font = '16px sans-serif';
                    ctx.fillStyle = textColor;
                    ctx.fillText(data.weatherEmoji, xPixel, yTop);

                    // 風向（進行方向に対する相対角度）の描画
                    ctx.save();
                    ctx.translate(xPixel, yTop + 20);
                    // ベース文字を「→」とし、向かい風が「←」、追い風が「→」となるように角度を補正
                    ctx.rotate((data.windDirection - data.heading + 180) * Math.PI / 180);
                    ctx.font = '16px sans-serif';
                    ctx.fillStyle = '#3498db';
                    ctx.fillText('→', 0, 0);
                    ctx.restore();

                    // 風速の描画
                    ctx.font = '11px sans-serif';
                    ctx.fillStyle = textColor;
                    ctx.fillText(data.windSpeed + 'm', xPixel, yTop + 35);
                });
                ctx.restore();
            }
        };

        this.chartInstance = new Chart(canvas, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: '標高 (m)',
                        data: eleData,
                        yAxisID: 'y-ele',
                        borderColor: '#2ecc71',
                        backgroundColor: 'rgba(46, 204, 113, 0.2)',
                        fill: true,
                        tension: 0.1,
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        borderWidth: 2
                    }
                ]
            },
            plugins: [weatherPinPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                onHover: (e, activeElements) => {
                    if (activeElements && activeElements.length > 0) {
                        const index = activeElements[0].index;
                        const point = points[index];
                        
                        // マップ上の連携マーカー表示
                        if (this.hoverMarker) {
                            this.hoverMarker.setLatLng([point.lat, point.lng]);
                        } else {
                            this.hoverMarker = L.circleMarker([point.lat, point.lng], {
                                radius: 8,
                                fillColor: "#e74c3c",
                                color: "#ffffff",
                                weight: 2,
                                opacity: 1,
                                fillOpacity: 1,
                                interactive: false
                            }).addTo(this.mapInstance);
                        }
                        this.hoverMarker.bringToFront();

                        // 天気リストの該当列ハイライト処理
                        let closestIdx = -1;
                        let minDiff = Infinity;
                        for (let i = 0; i < weatherData.length; i++) {
                            const diff = Math.abs(weatherData[i].totalDistance - point.totalDistance);
                            if (diff < minDiff) {
                                minDiff = diff;
                                closestIdx = i;
                            }
                        }
                        
                        const hasClosestData = closestIdx !== -1;
                        if (hasClosestData) {
                            this.HighlightTableColumn(closestIdx);
                        }
                    } else {
                        if (this.hoverMarker) {
                            this.mapInstance.removeLayer(this.hoverMarker);
                            this.hoverMarker = null;
                        }
                        this.HighlightTableColumn(-1);
                    }
                },
                plugins: {
                    legend: {
                        display: false // カスタムHTMLで表示するため標準の凡例は非表示
                    },
                    tooltip: {
                        callbacks: {
                            title: function(context) {
                                return '距離: ' + context[0].parsed.x.toFixed(1) + ' km';
                            },
                            label: function(context) {
                                return '標高: ' + Math.round(context.parsed.y) + ' m';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        position: 'bottom',
                        title: { display: true, text: '距離 (km)', color: textColor },
                        ticks: {
                            color: textColor,
                            callback: function(value) { return value.toFixed(1); }
                        },
                        grid: { color: gridColor }
                    },
                    'y-ele': {
                        type: 'linear',
                        display: true,
                        position: 'left',
                        title: { display: true, text: '標高 (m)', color: textColor },
                        ticks: { color: textColor },
                        grid: { color: gridColor },
                        suggestedMax: suggestedMaxEle
                    }
                }
            }
        });

        // グラフ領域から外れたらマーカーとハイライトを消去する
        canvas.addEventListener('mouseout', () => {
            if (this.hoverMarker) {
                this.mapInstance.removeLayer(this.hoverMarker);
                this.hoverMarker = null;
            }
            this.HighlightTableColumn(-1);
            // ツールチップとアクティブポイントを消す
            this.SyncChartHover(-1);
        });
    }

    // 保持しているGPXデータと現在の設定値を用いて地図とリストを再計算・再描画する非同期メソッド
    async UpdateDisplay() {
        let startIndex = 0;
        let startTime = new Date();

        const appMode = GetRadioValue('appMode');
        const isNavMode = appMode === 'nav';

        if (isNavMode) {
            try {
                const currentPos = await GetCurrentLocation();
                this.currentLocation = currentPos;
                startIndex = FindNearestPointIndex(currentPos.lat, currentPos.lng, this.currentRoutePoints);
                startTime = new Date();
            } catch (error) {
                alert("現在地の取得に失敗しました。ルート計画モードに切り替えるか、位置情報の設定を確認してください。");
                return;
            }
        } else {
            this.currentLocation = null;
            const startTimeInput = document.getElementById('inputStartTime').value;
            const hasStartTime = startTimeInput !== "";
            if (!hasStartTime) {
                alert("スタート日時を設定してください。");
                return;
            }
            startTime = new Date(startTimeInput);
        }

        // 速度モードに応じた設定値を取得
        const speedMode = GetRadioValue('speedMode');
        let speeds = {};
        if (speedMode === 'manual') {
            speeds = {
                climb: parseFloat(document.getElementById('inputClimbSpeedManual').value),
                flat: parseFloat(document.getElementById('inputFlatSpeedManual').value),
                descend: parseFloat(document.getElementById('inputDescendSpeedManual').value)
            };
        } else {
            speeds = {
                extremeClimb: parseFloat(document.getElementById('inputExtremeClimbSpeed').value),
                steepClimb: parseFloat(document.getElementById('inputSteepClimbSpeed').value),
                climb: parseFloat(document.getElementById('inputClimbSpeed').value),
                flat: parseFloat(document.getElementById('inputFlatSpeed').value),
                descend: parseFloat(document.getElementById('inputDescendSpeed').value),
                steepDescend: parseFloat(document.getElementById('inputSteepDescendSpeed').value),
                extremeDescend: parseFloat(document.getElementById('inputExtremeDescendSpeed').value)
            };
        }
        
        const fetchMethod = document.getElementById('inputFetchMethod').value;
        const pointCount = parseInt(document.getElementById('inputPointCount').value, 10);
        const timeInterval = parseInt(document.getElementById('inputTimeInterval').value, 10);
        const gradientSpan = parseInt(document.getElementById('inputGradientSpan').value, 10);
        const markerDisplayMode = document.getElementById('inputMarkerDisplayMode').value;

        this.ClearMapAndList();

        CalculateEstimatedTimes(this.currentRoutePoints, startTime, speeds, speedMode, gradientSpan, startIndex);
        
        this.routeLayer = DrawRoute(this.mapInstance, this.currentRoutePoints, gradientSpan);
        
        // 追加: ルート上のマウスホバー連携処理
        this.routeLayer.on('mousemove', (e) => {
            if (!this.currentRoutePoints || this.currentRoutePoints.length === 0) return;
            
            const closestPointIdx = FindNearestPointIndex(e.latlng.lat, e.latlng.lng, this.currentRoutePoints);
            const point = this.currentRoutePoints[closestPointIdx];

            // 1. 地図上のマーカーを更新
            if (this.hoverMarker) {
                this.hoverMarker.setLatLng([point.lat, point.lng]);
            } else {
                this.hoverMarker = L.circleMarker([point.lat, point.lng], {
                    radius: 8,
                    fillColor: "#e74c3c",
                    color: "#ffffff",
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 1,
                    interactive: false
                }).addTo(this.mapInstance);
            }
            this.hoverMarker.bringToFront();

            // 2. 天気リストの該当列ハイライト処理
            let closestWeatherIdx = -1;
            let minDiff = Infinity;
            for (let i = 0; i < this.weatherDataCache.length; i++) {
                const diff = Math.abs(this.weatherDataCache[i].totalDistance - point.totalDistance);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestWeatherIdx = i;
                }
            }
            if (closestWeatherIdx !== -1) {
                this.HighlightTableColumn(closestWeatherIdx);
            }

            // 3. グラフの●（ツールチップ）を表示
            this.SyncChartHover(closestPointIdx);
        });

        this.routeLayer.on('mouseout', () => {
            if (this.hoverMarker) {
                this.mapInstance.removeLayer(this.hoverMarker);
                this.hoverMarker = null;
            }
            this.HighlightTableColumn(-1);
            this.SyncChartHover(-1);
        });
        
        if (isNavMode) {
            const hasCurrentLocation = this.currentLocation !== null;
            if (hasCurrentLocation) {
                const currentLocMarker = L.circleMarker([this.currentLocation.lat, this.currentLocation.lng], {
                    radius: 8,
                    fillColor: "#e74c3c",
                    color: "#ffffff",
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 1
                }).addTo(this.mapInstance).bindPopup("<div style='font-size:14px;font-weight:bold;'>現在地</div>");
                this.weatherMarkers.push(currentLocMarker);
            }
        }

        // 天気取得前にも一旦グラフを描画しておく
        this.DrawChart(this.currentRoutePoints);

        const hasCurrentController = this.currentAbortController !== null;
        if (hasCurrentController) {
            this.currentAbortController.abort();
        }
        this.currentAbortController = new AbortController();
        const signal = this.currentAbortController.signal;
        
        FetchRouteWeather(this.mapInstance, this.currentRoutePoints, this.weatherMarkers, this.weatherDataCache, fetchMethod, pointCount, timeInterval, markerDisplayMode, signal, startIndex)
            .then(() => {
                if (!signal.aborted) {
                    // 天気データの取得完了後に天気のアイコンとピンを含めてグラフを再描画
                    this.DrawChart(this.currentRoutePoints);
                }
            })
            .catch(error => {
                const isAbort = error.name === 'AbortError';
                if (!isAbort) console.error(error);
            });
    }

    // 拡張子に応じてファイルを解析し、共通のポイント配列を返す汎用メソッド
    async LoadPointsFromFile(file) {
        const lowerName = file.name.toLowerCase();
        
        if (lowerName.endsWith('.gpx')) {
            const text = await file.text();
            return ParseGpx(text);
        } else if (lowerName.endsWith('.kml')) {
            const text = await file.text();
            return ParseKml(text);
        } else if (lowerName.endsWith('.fit')) {
            const buffer = await file.arrayBuffer();
            return await ParseFit(buffer);
        } else if (lowerName.endsWith('.kmz')) {
            const buffer = await file.arrayBuffer();
            return await ParseKmz(buffer);
        } else {
            throw new Error("非対応のファイル形式です");
        }
    }

    // ルート選択時のイベントを処理するメソッド
    async HandleFileSelect(event) {
        const fileList = event.target.files;
        const fileExists = fileList.length > 0;
        
        if (!fileExists) {
            return;
        }

        this.SaveSettings();
        const file = fileList[0];

        try {
            const routePoints = await this.LoadPointsFromFile(file);
            const routePointsExists = routePoints.length > 0;
            if (routePointsExists) {
                this.currentRoutePoints = routePoints;
                this.hasRouteData = true;
                this.UpdateDisplay();
            } else {
                alert("ファイルからルート情報を取得できませんでした。");
            }
        } catch (error) {
            console.error("ルート読み込みエラー:", error);
            alert("ファイルの読み込みに失敗しました。");
        }
        
        // 同じファイルを選び直せるようリセット
        event.target.value = "";
    }

    // 選択された過去ログから平均速度を算出するメソッド
    async ProcessLogFiles(files) {
        const speedData = {
            extremeClimb: [], steepClimb: [], climb: [],
            flat: [], descend: [], steepDescend: [], extremeDescend: []
        };

        let processedCount = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                const points = await this.LoadPointsFromFile(file);
                const hasPoints = points.length > 0;
                if (hasPoints) {
                    this.ExtractSpeedFromPoints(points, speedData);
                    processedCount++;
                }
            } catch (err) {
                console.error("ログファイル読み込みエラー:", err);
            }
        }

        const hasProcessedFiles = processedCount > 0;
        if (hasProcessedFiles) {
            this.UpdateSpeedFormFromData(speedData);
        } else {
            alert("有効な速度データがログから抽出できませんでした。");
        }
    }

    // 共通のポイント配列からポイント間の速度と勾配を抽出して分類するメソッド
    ExtractSpeedFromPoints(points, speedData) {
        let anchorPoint = null;
        
        for (let i = 0; i < points.length; i++) {
            const pt = points[i];
            const hasTimeData = pt.time !== null;
            
            if (hasTimeData) {
                const isFirstPoint = anchorPoint === null;
                if (isFirstPoint) {
                    anchorPoint = pt;
                    continue;
                }

                const dist = CalculateDistance(anchorPoint.lat, anchorPoint.lng, pt.lat, pt.lng);
                
                // 50メートル (0.05km) 以上の移動があった場合に速度を計算する
                const isFarEnough = dist >= 0.05;
                if (isFarEnough) {
                    const timeDiffHours = (pt.time.getTime() - anchorPoint.time.getTime()) / (1000 * 60 * 60);
                    const eleDiff = pt.ele - anchorPoint.ele;
                    
                    ClassifySpeedData(dist, timeDiffHours, eleDiff, speedData);
                    
                    anchorPoint = pt;
                }
            }
        }
    }

    // 抽出された速度データをフォームの入力欄に反映して保存するメソッド
    UpdateSpeedFormFromData(speedData) {
        const calcAvg = (arr, currentValStr) => {
            const hasNoData = arr.length === 0;
            if (hasNoData) return currentValStr;
            const sum = arr.reduce((a, b) => a + b, 0);
            return Math.round(sum / arr.length).toString();
        };

        const ids = [
            { id: 'inputExtremeClimbSpeed', data: speedData.extremeClimb },
            { id: 'inputSteepClimbSpeed', data: speedData.steepClimb },
            { id: 'inputClimbSpeed', data: speedData.climb },
            { id: 'inputFlatSpeed', data: speedData.flat },
            { id: 'inputDescendSpeed', data: speedData.descend },
            { id: 'inputSteepDescendSpeed', data: speedData.steepDescend },
            { id: 'inputExtremeDescendSpeed', data: speedData.extremeDescend }
        ];

        let hasUpdates = false;

        for (let i = 0; i < ids.length; i++) {
            const el = document.getElementById(ids[i].id);
            const elementExists = el !== null;
            const hasExtractedData = ids[i].data.length > 0;
            
            if (elementExists && hasExtractedData) {
                el.value = calcAvg(ids[i].data, el.value);
                hasUpdates = true;
            }
        }

        if (hasUpdates) {
            this.SaveSettings();
            
            // ファイル入力欄をリセットして同じファイルを再選択できるようにする
            const fileInput = document.getElementById('logFileInput');
            if (fileInput) fileInput.value = "";
            
            alert("ログデータから過去の平均速度を算出し、設定を更新しました！\n（データが存在しない勾配区分は元の設定を維持しています）");
            
            if (this.hasRouteData) {
                this.UpdateDisplay();
            }
        } else {
            alert("有効な速度データがログから抽出できませんでした。");
        }
    }
}

// 距離・時間・標高差から速度と勾配を求め、適切なカテゴリの配列に分類する関数
function ClassifySpeedData(distKm, timeDiffHours, eleDiffMeters, speedData) {
    const hasTime = timeDiffHours > 0;
    if (hasTime) {
        const speed = distKm / timeDiffHours;
        // 極端に遅い（2km/h未満の歩き・停止）や異常に速い（100km/h以上）データはノイズとして除外
        const isValidSpeed = speed > 2 && speed < 100;
        
        if (isValidSpeed) {
            const gradient = (eleDiffMeters / (distKm * 1000)) * 100;
            
            const isExtremeClimb = gradient >= 10;
            const isSteepClimb = gradient >= 5;
            const isClimb = gradient >= 2;
            const isExtremeDescend = gradient <= -10;
            const isSteepDescend = gradient <= -5;
            const isDescend = gradient <= -2;
            
            if (isExtremeClimb) speedData.extremeClimb.push(speed);
            else if (isSteepClimb) speedData.steepClimb.push(speed);
            else if (isClimb) speedData.climb.push(speed);
            else if (isExtremeDescend) speedData.extremeDescend.push(speed);
            else if (isSteepDescend) speedData.steepDescend.push(speed);
            else if (isDescend) speedData.descend.push(speed);
            else speedData.flat.push(speed);
        }
    }
}

// 現在位置をGPSから取得する非同期関数
function GetCurrentLocation() {
    return new Promise((resolve, reject) => {
        const hasGeolocation = navigator.geolocation !== undefined;
        if (!hasGeolocation) {
            reject(new Error("Geolocationがサポートされていません"));
        } else {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    resolve({ lat: position.coords.latitude, lng: position.coords.longitude });
                },
                (error) => {
                    reject(error);
                },
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
            );
        }
    });
}

// 2点間の距離をHaversineの公式で計算する関数（単位：km）
function CalculateDistance(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return constEarthRadiusKm * c;
}

// 2点間の方位角（進行方向）を計算する関数
function CalculateBearing(lat1, lon1, lat2, lon2) {
    const lat1Rad = lat1 * Math.PI / 180;
    const lat2Rad = lat2 * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
    let brng = Math.atan2(y, x);
    return (brng * 180 / Math.PI + 360) % 360;
}

// 方位角（度）から16方位の文字列を取得する関数
function GetHeadingString(bearing) {
    const directions = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"];
    const index = Math.round(bearing / 22.5) % 16;
    return directions[index];
}

// 指定した緯度経度に最も近いルート上のインデックスを取得する関数
function FindNearestPointIndex(targetLat, targetLng, points) {
    let minDistance = Infinity;
    let nearestIndex = 0;
    for (let i = 0; i < points.length; i++) {
        const distance = CalculateDistance(targetLat, targetLng, points[i].lat, points[i].lng);
        const isCloser = distance < minDistance;
        if (isCloser) {
            minDistance = distance;
            nearestIndex = i;
        }
    }
    return nearestIndex;
}

// 複数ポイント間のスパンで平滑化した勾配（%）を計算する関数
function CalculateSmoothedGradient(points, startIndex, spanCount) {
    const p1 = points[startIndex];
    const targetIndex = Math.min(startIndex + spanCount, points.length - 1);
    
    const isSamePoint = startIndex === targetIndex;
    if (isSamePoint) {
        return 0;
    }

    const pTarget = points[targetIndex];
    const distance = CalculateDistance(p1.lat, p1.lng, pTarget.lat, pTarget.lng);
    const hasDistance = distance > 0;
    
    if (hasDistance) {
        const eleDiff = pTarget.ele - p1.ele;
        return (eleDiff / (distance * 1000)) * 100;
    }
    return 0;
}

// 勾配に応じてクラス名を返す関数（7段階拡張版）
function GetGradientClass(gradient) {
    const isExtremeClimb = gradient >= 10;
    const isSteepClimb = gradient >= 5;
    const isClimb = gradient >= 2;
    const isExtremeDescend = gradient <= -10;
    const isSteepDescend = gradient <= -5;
    const isDescend = gradient <= -2;

    if (isExtremeClimb) return 'route-extreme-climb';
    if (isSteepClimb) return 'route-steep-climb';
    if (isClimb) return 'route-climb';
    if (isExtremeDescend) return 'route-extreme-descend';
    if (isSteepDescend) return 'route-steep-descend';
    if (isDescend) return 'route-descend';
    
    return 'route-flat';
}

// 勾配と速度に基づいて各ポイントへの到着予想時刻および累積距離を計算する関数
function CalculateEstimatedTimes(points, startTime, speeds, speedMode, gradientSpan, startIndex = 0) {
    let currentTimeMs = startTime.getTime();
    let currentTotalDistance = 0;
    
    for (let i = 0; i < startIndex; i++) {
        points[i].estimatedTime = null;
        points[i].totalDistance = 0;
        points[i].calculatedSpeed = 0;
    }

    for (let i = startIndex; i < points.length; i++) {
        points[i].estimatedTime = new Date(currentTimeMs);
        points[i].totalDistance = currentTotalDistance;
        
        const isNotLastPoint = i < points.length - 1;
        if (isNotLastPoint) {
            const p1 = points[i];
            const p2 = points[i + 1];
            
            const distance = CalculateDistance(p1.lat, p1.lng, p2.lat, p2.lng);
            const hasDistance = distance > 0;
            
            if (hasDistance) {
                currentTotalDistance += distance;
                
                const gradient = CalculateSmoothedGradient(points, i, gradientSpan);
                let currentSpeed = speeds.flat;
                
                const isManualMode = speedMode === 'manual';
                if (isManualMode) {
                    // 手動モードの場合はシンプルな3段階判定
                    const isManualClimb = gradient >= 2;
                    const isManualDescend = gradient <= -2;
                    
                    if (isManualClimb) currentSpeed = speeds.climb;
                    else if (isManualDescend) currentSpeed = speeds.descend;
                } else {
                    // 自動モードの場合は7段階判定
                    const isExtremeClimb = gradient >= 10;
                    const isSteepClimb = gradient >= 5;
                    const isClimb = gradient >= 2;
                    const isExtremeDescend = gradient <= -10;
                    const isSteepDescend = gradient <= -5;
                    const isDescend = gradient <= -2;

                    if (isExtremeClimb) currentSpeed = speeds.extremeClimb;
                    else if (isSteepClimb) currentSpeed = speeds.steepClimb;
                    else if (isClimb) currentSpeed = speeds.climb;
                    else if (isExtremeDescend) currentSpeed = speeds.extremeDescend;
                    else if (isSteepDescend) currentSpeed = speeds.steepDescend;
                    else if (isDescend) currentSpeed = speeds.descend;
                }
                
                points[i].calculatedSpeed = currentSpeed;
                const durationHours = distance / currentSpeed;
                currentTimeMs += durationHours * 60 * 60 * 1000;
            } else {
                points[i].calculatedSpeed = i > 0 ? points[i - 1].calculatedSpeed : speeds.flat;
            }
        } else {
            points[i].calculatedSpeed = i > 0 ? points[i - 1].calculatedSpeed : speeds.flat;
        }
    }
}

// 勾配に応じて色を塗り分けながらルート線を地図上に描画する関数
function DrawRoute(mapObj, points, gradientSpan) {
    const pathGroup = L.featureGroup().addTo(mapObj);
    let currentLine = [];
    let currentClass = null;

    // 当たり判定用の透明なポリラインを描画するための配列
    const hitAreaLine = [];

    for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        
        hitAreaLine.push([p1.lat, p1.lng]);

        const gradient = CalculateSmoothedGradient(points, i, gradientSpan);
        const segmentClass = GetGradientClass(gradient); // 描画色はモードによらず常に7段階
        
        const isInitial = currentClass === null;
        const isSameClass = currentClass === segmentClass;

        if (isInitial) {
            currentClass = segmentClass;
            currentLine = [[p1.lat, p1.lng], [p2.lat, p2.lng]];
        } else if (isSameClass) {
            currentLine.push([p2.lat, p2.lng]);
        } else {
            L.polyline(currentLine, { className: currentClass, weight: 5, interactive: false }).addTo(pathGroup);
            currentClass = segmentClass;
            currentLine = [[p1.lat, p1.lng], [p2.lat, p2.lng]];
        }
    }
    
    const hasRemainingLine = currentLine.length > 0;
    if (hasRemainingLine) {
        L.polyline(currentLine, { className: currentClass, weight: 5, interactive: false }).addTo(pathGroup);
    }
    
    const hasPoints = points.length > 0;
    if (hasPoints) {
        hitAreaLine.push([points[points.length - 1].lat, points[points.length - 1].lng]);
    }

    // 地図上でマウスホバーイベントを拾うための透明で太い線を追加
    L.polyline(hitAreaLine, {
        color: 'rgba(0,0,0,0)',
        weight: 20,
        opacity: 0,
        interactive: true
    }).addTo(pathGroup);

    mapObj.fitBounds(pathGroup.getBounds(), {
        paddingTopLeft: [30, 30],
        paddingBottomRight: [30, 80]
    });
    
    return pathGroup;
}

// 予報データの時間配列から、到着予想時刻に最も近いインデックスを検索する関数
function FindClosestWeatherIndex(hourlyTimes, targetTime) {
    let closestIndex = 0;
    let minDiff = Infinity;
    const targetMs = targetTime.getTime();

    for (let i = 0; i < hourlyTimes.length; i++) {
        const forecastTimeMs = new Date(hourlyTimes[i]).getTime();
        const diff = Math.abs(forecastTimeMs - targetMs);
        
        const isCloser = diff < minDiff;
        if (isCloser) {
            minDiff = diff;
            closestIndex = i;
        }
    }
    return closestIndex;
}

// WMO天気コードから天気の詳細（テキストと絵文字のオブジェクト）を取得する関数
function GetWeatherDescription(weatherCode) {
    switch (weatherCode) {
        case 0: return { text: "快晴", emoji: "☀️" };
        case 1: return { text: "晴れ", emoji: "🌤️" };
        case 2: return { text: "所により曇り", emoji: "⛅" };
        case 3: return { text: "曇り", emoji: "☁️" };
        case 45:
        case 48: return { text: "霧", emoji: "🌫️" };
        case 51:
        case 53:
        case 55: return { text: "霧雨", emoji: "🌧️" };
        case 56:
        case 57: return { text: "着氷性の霧雨", emoji: "🌧️❄️" };
        case 61:
        case 63:
        case 65: return { text: "雨", emoji: "☔" };
        case 66:
        case 67: return { text: "着氷性の雨", emoji: "☔❄️" };
        case 71:
        case 73:
        case 75: return { text: "雪", emoji: "⛄" };
        case 77: return { text: "霧雪", emoji: "⛄" };
        case 80:
        case 81:
        case 82: return { text: "にわか雨", emoji: "🌦️" };
        case 85:
        case 86: return { text: "にわか雪", emoji: "🌨️" };
        case 95: return { text: "雷雨", emoji: "⛈️" };
        case 96:
        case 99: return { text: "雷雨（ひょう）", emoji: "⛈️🧊" };
        default: return { text: "不明", emoji: "❓" };
    }
}

// 表示モードに応じて情報パネル（マーカー）のHTMLとサイズを生成する関数
function CreateCustomIcon(pointLabel, timeString, weatherEmoji, windDirection, windSpeed, displayMode, heading, headingStr) {
    let htmlContent = '';
    let size = [135, 48];
    let anchor = [67, 24];
    
    if (displayMode === 'weatherWind') {
        htmlContent = `
            <div class="custom-info-box">
                <div class="custom-info-number">${pointLabel}</div>
                <div class="custom-info-details">
                    <div class="custom-info-row">
                        <span style="font-size: 16px;" title="天気">${weatherEmoji}</span>
                        <span class="wind-arrow" style="transform: rotate(${windDirection}deg);" title="風向">↓</span>
                        <span>${windSpeed} m/s</span>
                        <span style="display:inline-block; transform: rotate(${heading}deg); color: var(--heading-arrow-color); font-weight:bold; margin-left: 4px;" title="進路: ${headingStr}">↑</span>
                    </div>
                </div>
            </div>
        `;
        size = [135, 36];
        anchor = [67, 18];
    } else if (displayMode === 'windOnly') {
        htmlContent = `
            <div class="transparent-marker-container">
                <div class="transparent-marker-number">${pointLabel}</div>
                <div class="arrow-overlap-wrapper">
                    <span class="transparent-arrow-icon" style="transform: rotate(${windDirection}deg);" title="風向">↓</span>
                    <span class="overlap-wind-speed" title="風速">${windSpeed}</span>
                </div>
                <div style="font-size: 14px; color: var(--heading-arrow-color); font-weight: 900; text-shadow: 1px 1px 0 var(--text-shadow-color), -1px -1px 0 var(--text-shadow-color), 1px -1px 0 var(--text-shadow-color), -1px 1px 0 var(--text-shadow-color); margin-top: 2px;">
                    <span style="display:inline-block; transform: rotate(${heading}deg);" title="進路: ${headingStr}">↑</span>
                </div>
            </div>
        `;
        size = [55, 60];
        anchor = [27, 30];
    } else if (displayMode === 'arrowOnly') {
        htmlContent = `
            <div class="transparent-marker-container">
                <div class="transparent-marker-number">${pointLabel}</div>
                <span class="transparent-arrow-icon" style="transform: rotate(${windDirection}deg);" title="風向">↓</span>
                <div style="font-size: 14px; color: var(--heading-arrow-color); font-weight: 900; text-shadow: 1px 1px 0 var(--text-shadow-color), -1px -1px 0 var(--text-shadow-color), 1px -1px 0 var(--text-shadow-color), -1px 1px 0 var(--text-shadow-color); margin-top: 2px;">
                    <span style="display:inline-block; transform: rotate(${heading}deg);" title="進路: ${headingStr}">↑</span>
                </div>
            </div>
        `;
        size = [55, 60];
        anchor = [27, 30];
    } else {
        htmlContent = `
            <div class="custom-info-box">
                <div class="custom-info-number">${pointLabel}</div>
                <div class="custom-info-details">
                    <div style="margin-top: -2px; font-size: 10px; text-align: center;">${timeString}</div>
                    <div class="custom-info-row">
                        <span style="font-size: 16px;" title="天気">${weatherEmoji}</span>
                        <span class="wind-arrow" style="transform: rotate(${windDirection}deg);" title="風向">↓</span>
                        <span>${windSpeed} m/s</span>
                        <span style="display:inline-block; transform: rotate(${heading}deg); color: var(--heading-arrow-color); font-weight:bold; margin-left: 4px;" title="進路: ${headingStr}">↑</span>
                    </div>
                </div>
            </div>
        `;
        size = [135, 48];
        anchor = [67, 24];
    }

    return L.divIcon({
        className: 'custom-pin-wrapper',
        html: htmlContent,
        iconSize: size,
        iconAnchor: anchor,
        popupAnchor: [0, -anchor[1]]
    });
}

// 外部APIから天候情報を取得し、地図とタイムライン表に表示する非同期関数
async function FetchRouteWeather(mapObj, points, markerArray, weatherCacheArray, fetchMethod, targetPointCount, targetTimeInterval, displayMode, abortSignal, startIndex = 0) {
    const validPoints = [];
    for (let i = startIndex; i < points.length; i++) {
        validPoints.push(points[i]);
    }

    const pointsExists = validPoints.length > 0;
    if (!pointsExists) {
        return;
    }

    const targetPoints = [];
    const isPointCountMethod = fetchMethod === 'pointCount';
    if (isPointCountMethod) {
        const constWeatherInterval = Math.max(1, Math.floor(validPoints.length / targetPointCount));
        for (let i = 0; i < validPoints.length; i += constWeatherInterval) {
            targetPoints.push(validPoints[i]);
        }
    } else {
        targetPoints.push(validPoints[0]);
        let lastTimeMs = validPoints[0].estimatedTime.getTime();
        const intervalMs = targetTimeInterval * 60 * 1000;
        
        for (let i = 1; i < validPoints.length; i++) {
            const currentTimeMs = validPoints[i].estimatedTime.getTime();
            const isTimePassed = (currentTimeMs - lastTimeMs) >= intervalMs;
            if (isTimePassed) {
                targetPoints.push(validPoints[i]);
                lastTimeMs = currentTimeMs;
            }
        }
    }

    const lastPoint = validPoints[validPoints.length - 1];
    const lastAddedPoint = targetPoints[targetPoints.length - 1];
    const isNotIncluded = lastPoint !== lastAddedPoint;
    if (isNotIncluded) {
        targetPoints.push(lastPoint);
    }

    const rowPoint = document.getElementById('row-point');
    const rowDistance = document.getElementById('row-distance');
    const rowDate = document.getElementById('row-date');
    const rowTime = document.getElementById('row-time');
    const rowWeather = document.getElementById('row-weather');
    const rowPrecip = document.getElementById('row-precip');
    const rowTemp = document.getElementById('row-temp');
    const rowWind = document.getElementById('row-wind');
    const rowHeading = document.getElementById('row-heading');

    const hasTableRows = rowPoint && rowDistance && rowDate && rowTime && rowWeather && rowPrecip && rowTemp && rowWind && rowHeading;

    let lastDateStr = "";
    let lastDateCell = null;

    for (let i = 0; i < targetPoints.length; i++) {
        const currentPoint = targetPoints[i];
        const currentMarkerIndex = i + 1;
        const isLastTarget = i === targetPoints.length - 1;
        
        try {
            const requestUrl = `${constWeatherApiUrl}?latitude=${currentPoint.lat}&longitude=${currentPoint.lng}&hourly=temperature_2m,windspeed_10m,winddirection_10m,precipitation,precipitation_probability,weathercode&windspeed_unit=ms&timezone=auto`;
            const response = await fetch(requestUrl, { signal: abortSignal });
            const weatherData = await response.json();
            
            const isSuccess = response.ok;
            const hasWeatherData = weatherData.hourly !== undefined;
            
            if (isSuccess && hasWeatherData) {
                const targetIndex = FindClosestWeatherIndex(weatherData.hourly.time, currentPoint.estimatedTime);
                
                const temperature = Math.round(weatherData.hourly.temperature_2m[targetIndex]);
                const windSpeed = Math.round(weatherData.hourly.windspeed_10m[targetIndex]);
                const windDirection = weatherData.hourly.winddirection_10m[targetIndex];
                const precipitation = Math.round(weatherData.hourly.precipitation[targetIndex]);
                const precipitationProbability = weatherData.hourly.precipitation_probability ? Math.round(weatherData.hourly.precipitation_probability[targetIndex]) : 0;
                const weatherCode = weatherData.hourly.weathercode[targetIndex];
                
                const weatherDesc = GetWeatherDescription(weatherCode);
                const weatherDescStr = `${weatherDesc.text} ${weatherDesc.emoji}`;
                
                const hours = currentPoint.estimatedTime.getHours().toString().padStart(2, '0');
                const minutes = currentPoint.estimatedTime.getMinutes().toString().padStart(2, '0');
                const formattedTimeStr = `${hours}:${minutes}`;
                
                const timeString = currentPoint.estimatedTime.toLocaleString('ja-JP', { 
                    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' 
                });
                
                let pointLabelStr = currentMarkerIndex.toString();
                if (isLastTarget) {
                    pointLabelStr = "終";
                }

                // 進行方向（方位角）を計算
                const origIndex = points.indexOf(currentPoint);
                let heading = 0;
                if (origIndex < points.length - 1) {
                    const nextPoint = points[origIndex + 1];
                    heading = CalculateBearing(currentPoint.lat, currentPoint.lng, nextPoint.lat, nextPoint.lng);
                } else if (origIndex > 0) {
                    const prevPoint = points[origIndex - 1];
                    heading = CalculateBearing(prevPoint.lat, prevPoint.lng, currentPoint.lat, currentPoint.lng);
                }
                const headingStr = GetHeadingString(heading);
                
                const popupContent = `
                    <div style="font-size:14px;">
                        <strong>地点 ${pointLabelStr}</strong><br>
                        到着予想: ${timeString}<br>
                        天気: ${weatherDescStr}<br>
                        降水確率: ${precipitationProbability}%<br>
                        降水量: ${precipitation} mm<br>
                        気温: ${temperature} °C<br>
                        風: ${windSpeed} m/s<br>
                        進路: ${headingStr}
                    </div>
                `;
                
                const weatherDataObj = {
                    lat: currentPoint.lat,
                    lng: currentPoint.lng,
                    totalDistance: currentPoint.totalDistance,
                    pointLabelStr: pointLabelStr,
                    timeString: timeString,
                    weatherEmoji: weatherDesc.emoji,
                    windDirection: windDirection,
                    windSpeed: windSpeed,
                    heading: heading,
                    headingStr: headingStr,
                    precipitationProbability: precipitationProbability,
                    popupContent: popupContent
                };
                weatherCacheArray.push(weatherDataObj);
                
                const isNoneMode = displayMode === 'none';
                if (!isNoneMode) {
                    const marker = L.marker([currentPoint.lat, currentPoint.lng], { 
                        icon: CreateCustomIcon(pointLabelStr, timeString, weatherDesc.emoji, windDirection, windSpeed, displayMode, heading, headingStr) 
                    }).addTo(mapObj).bindPopup(popupContent);
                     
                    markerArray.push(marker);
                }

                if (hasTableRows) {
                    // 直前のターゲットポイントからの距離と平均勾配を計算
                    let distFromPrev = 0;
                    let gradientFromPrev = 0;
                    if (i > 0) {
                        const prevTarget = targetPoints[i - 1];
                        distFromPrev = currentPoint.totalDistance - prevTarget.totalDistance;
                        
                        const eleDiff = currentPoint.ele - prevTarget.ele;
                        const hasDist = distFromPrev > 0;
                        if (hasDist) {
                            gradientFromPrev = (eleDiff / (distFromPrev * 1000)) * 100;
                        }
                    }
                    
                    const distStr = distFromPrev.toFixed(1);
                    const isPositiveGradient = gradientFromPrev > 0;
                    const gradStr = isPositiveGradient ? `+${gradientFromPrev.toFixed(1)}` : gradientFromPrev.toFixed(1);

                    const dateObj = currentPoint.estimatedTime;
                    const day = dateObj.getDate();
                    const dayOfWeek = ['日','月','火','水','木','金','土'][dateObj.getDay()];
                    const dateStr = `${day}日(${dayOfWeek})`;

                    const tdPoint = document.createElement('td');
                    tdPoint.textContent = pointLabelStr;
                    tdPoint.className = 'clickable-point';
                    tdPoint.title = 'クリックして地図を移動';
                    tdPoint.addEventListener('click', () => {
                        mapObj.flyTo([currentPoint.lat, currentPoint.lng], 14, {
                            duration: 0.5
                        });
                    });
                    rowPoint.appendChild(tdPoint);

                    const tdDistance = document.createElement('td');
                    tdDistance.innerHTML = `<strong>${distStr}</strong><span class="unit-text">km</span><br><span style="font-size: 0.75rem; opacity: 0.8;" title="前の地点からの平均勾配">(${gradStr}%)</span>`;
                    rowDistance.appendChild(tdDistance);

                    const isSameDate = lastDateStr === dateStr;
                    if (isSameDate) {
                        const hasLastCell = lastDateCell !== null;
                        if (hasLastCell) {
                            lastDateCell.colSpan += 1;
                        }
                    } else {
                        const tdDate = document.createElement('td');
                        tdDate.textContent = dateStr;
                        rowDate.appendChild(tdDate);
                        lastDateStr = dateStr;
                        lastDateCell = tdDate;
                    }

                    const tdTime = document.createElement('td');
                    tdTime.textContent = formattedTimeStr;
                    rowTime.appendChild(tdTime);

                    const tdWeather = document.createElement('td');
                    tdWeather.innerHTML = `
                        <div style="font-size: 1.5rem;" title="${weatherDesc.text}">${weatherDesc.emoji}</div>
                        <div class="precip-probability-text" title="降水確率">${precipitationProbability}%</div>
                    `;
                    rowWeather.appendChild(tdWeather);

                    const tdPrecip = document.createElement('td');
                    tdPrecip.innerHTML = `<strong>${precipitation}</strong><span class="unit-text">ミリ</span>`;
                    rowPrecip.appendChild(tdPrecip);

                    const tdTemp = document.createElement('td');
                    tdTemp.innerHTML = `<strong>${temperature}</strong><span class="unit-text">℃</span>`;
                    rowTemp.appendChild(tdTemp);

                    const tdWind = document.createElement('td');
                    tdWind.innerHTML = `
                        <div style="display:inline-block; transform: rotate(${windDirection}deg); color: var(--wind-arrow-color); margin-bottom: 2px;">↓</div><br>
                        <strong>${windSpeed}</strong><span class="unit-text">m/s</span>
                    `;
                    rowWind.appendChild(tdWind);

                    const tdHeading = document.createElement('td');
                    tdHeading.innerHTML = `
                        <div style="display:inline-block; transform: rotate(${Math.round(heading)}deg); color: var(--heading-arrow-color); margin-bottom: 2px; font-size: 16px; font-weight: 900;">↑</div><br>
                        <span style="font-size: 12px; font-weight: bold;">${headingStr}</span>
                    `;
                    rowHeading.appendChild(tdHeading);
                }
            }
        } catch (error) {
            const isAbort = error.name === 'AbortError';
            if (isAbort) {
                console.log("重複設定変更のため、以前の天気データ取得をキャンセルしました。");
                break;
            }
            console.error("天気データの取得に失敗しました", error);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const appManager = new APP_MANAGER();
    appManager.InitializeApp();

    const fileInput = document.getElementById('routeFileInput');
    const fileInputExists = fileInput !== null;
    if (fileInputExists) {
        fileInput.addEventListener('change', (event) => appManager.HandleFileSelect(event));
    }
});