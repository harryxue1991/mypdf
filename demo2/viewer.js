"use strict";
function getOutputScale(ctx) {
    var devicePixelRatio = window.devicePixelRatio || 1;
    var backingStoreRatio = ctx.webkitBackingStorePixelRatio ||
            ctx.mozBackingStorePixelRatio ||
            ctx.msBackingStorePixelRatio ||
            ctx.oBackingStorePixelRatio ||
            ctx.backingStorePixelRatio || 1;
    var pixelRatio = devicePixelRatio / backingStoreRatio;
    return {
        sx: pixelRatio,
        sy: pixelRatio,
        scaled: pixelRatio !== 1
    };
}
var RenderingStates = {
    INITIAL: 0,
    RUNNING: 1,
    PAUSED: 2,
    FINISHED: 3
};
var TEXT_LAYER_RENDER_DELAY = 200; // ms
var CSS_UNITS = 96.0 / 72.0;
var DEFAULT_SCALE_VALUE = 'auto';
var DEFAULT_SCALE = 1.0;
var UNKNOWN_SCALE = 0;
var MAX_AUTO_SCALE = 2;
var SCROLLBAR_PADDING = 40;
var VERTICAL_PADDING = 5;

function DefaultTextLayerFactory() {
}
DefaultTextLayerFactory.prototype = {
    /**
     * @param {HTMLDivElement} textLayerDiv
     * @param {number} pageIndex
     * @param {PageViewport} viewport
     * @param {boolean} enhanceTextSelection
     * @returns {TextLayerBuilder}
     */
    createTextLayerBuilder: function (textLayerDiv, pageIndex, viewport,
                                      enhanceTextSelection) {
        return new TextLayerBuilder({
            textLayerDiv: textLayerDiv,
            pageIndex: pageIndex,
            viewport: viewport,
            enhanceTextSelection: enhanceTextSelection
        });
    }
};
var PDFPageView = (function PDFPageViewClosure() {
    /**
     * @constructs PDFPageView
     * @param {PDFPageViewOptions} options
     */
    function PDFPageView(options) {
        var container = options.container;
        var id = options.id;
        var scale = options.scale;
        var defaultViewport = options.defaultViewport;
        var renderingQueue = options.renderingQueue;
        var textLayerFactory = options.textLayerFactory;
        var annotationLayerFactory = options.annotationLayerFactory;
        var enhanceTextSelection = options.enhanceTextSelection || false;
        var renderInteractiveForms = options.renderInteractiveForms || false;

        this.id = id;
        this.renderingId = 'page' + id;

        this.rotation = 0;
        this.scale = scale || DEFAULT_SCALE;
        this.viewport = defaultViewport;
        this.pdfPageRotate = defaultViewport.rotation;
        this.hasRestrictedScaling = false;
        this.enhanceTextSelection = enhanceTextSelection;
        this.renderInteractiveForms = renderInteractiveForms;

        //this.eventBus = options.eventBus || domEvents.getGlobalEventBus();
        this.renderingQueue = renderingQueue;
        this.textLayerFactory = textLayerFactory;
        this.annotationLayerFactory = annotationLayerFactory;

        this.renderingState = RenderingStates.INITIAL;
        this.resume = null;

        this.onBeforeDraw = null;
        this.onAfterDraw = null;

        this.textLayer = null;

        this.zoomLayer = null;

        this.annotationLayer = null;

        var div = document.createElement('div');
        div.id = 'pageContainer' + this.id;
        div.className = 'page';
        div.style.width = Math.floor(this.viewport.width) + 'px';
        div.style.height = Math.floor(this.viewport.height) + 'px';
        div.style.position = 'relative';
        div.setAttribute('data-page-number', this.id);
        this.div = div;

        container.appendChild(div);
    }

    PDFPageView.prototype = {
        setPdfPage: function PDFPageView_setPdfPage(pdfPage) {
            this.pdfPage = pdfPage;
            this.pdfPageRotate = pdfPage.rotate;
            var totalRotation = (this.rotation + this.pdfPageRotate) % 360;
            this.viewport = pdfPage.getViewport(this.scale);
            this.stats = pdfPage.stats;
            this.reset();
        },

        destroy: function PDFPageView_destroy() {
            this.zoomLayer = null;
            this.reset();
            if (this.pdfPage) {
                this.pdfPage.cleanup();
            }
        },

        reset: function PDFPageView_reset(keepZoomLayer, keepAnnotations) {
            if (this.renderTask) {
                this.renderTask.cancel();
            }
            this.resume = null;
            this.renderingState = RenderingStates.INITIAL;

            var div = this.div;
            div.style.width = Math.floor(this.viewport.width) + 'px';
            div.style.height = Math.floor(this.viewport.height) + 'px';

            var childNodes = div.childNodes;
            var currentZoomLayerNode = (keepZoomLayer && this.zoomLayer) || null;
            var currentAnnotationNode = (keepAnnotations && this.annotationLayer &&
                    this.annotationLayer.div) || null;
            for (var i = childNodes.length - 1; i >= 0; i--) {
                var node = childNodes[i];
                if (currentZoomLayerNode === node || currentAnnotationNode === node) {
                    continue;
                }
                div.removeChild(node);
            }
            div.removeAttribute('data-loaded');

            if (currentAnnotationNode) {
                // Hide annotationLayer until all elements are resized
                // so they are not displayed on the already-resized page
                this.annotationLayer.hide();
            } else {
                this.annotationLayer = null;
            }

            if (this.canvas && !currentZoomLayerNode) {
                // Zeroing the width and height causes Firefox to release graphics
                // resources immediately, which can greatly reduce memory consumption.
                this.canvas.width = 0;
                this.canvas.height = 0;
                delete this.canvas;
            }

            this.loadingIconDiv = document.createElement('div');
            this.loadingIconDiv.className = 'loadingIcon';
            div.appendChild(this.loadingIconDiv);
        },

        update: function PDFPageView_update(scale, rotation) {
            this.scale = scale || this.scale;

            if (typeof rotation !== 'undefined') {
                this.rotation = rotation;
            }

            var totalRotation = (this.rotation + this.pdfPageRotate) % 360;
            this.viewport = this.viewport.clone({
                scale: this.scale * CSS_UNITS,
                rotation: totalRotation
            });

            var isScalingRestricted = false;
            if (this.canvas && PDFJS.maxCanvasPixels > 0) {
                var outputScale = this.outputScale;
                if (((Math.floor(this.viewport.width) * outputScale.sx) | 0) *
                        ((Math.floor(this.viewport.height) * outputScale.sy) | 0) >
                        PDFJS.maxCanvasPixels) {
                    isScalingRestricted = true;
                }
            }

            if (this.canvas) {
                if (PDFJS.useOnlyCssZoom ||
                        (this.hasRestrictedScaling && isScalingRestricted)) {
                    this.cssTransform(this.canvas, true);

//                            this.eventBus.dispatch('pagerendered', {
//                                source: this,
//                                pageNumber: this.id,
//                                cssTransform: true,
//                            });
                    return;
                }
                if (!this.zoomLayer) {
                    this.zoomLayer = this.canvas.parentNode;
                    this.zoomLayer.style.position = 'absolute';
                }
            }
            if (this.zoomLayer) {
                this.cssTransform(this.zoomLayer.firstChild);
            }
            this.reset(/* keepZoomLayer = */ true, /* keepAnnotations = */ true);
        },

        /**
         * Called when moved in the parent's container.
         */
        updatePosition: function PDFPageView_updatePosition() {
            if (this.textLayer) {
                this.textLayer.render(TEXT_LAYER_RENDER_DELAY);
            }
        },

        cssTransform: function PDFPageView_transform(canvas, redrawAnnotations) {
            var CustomStyle = PDFJS.CustomStyle;

            // Scale canvas, canvas wrapper, and page container.
            var width = this.viewport.width;
            var height = this.viewport.height;
            var div = this.div;
            canvas.style.width = canvas.parentNode.style.width = div.style.width =
                    Math.floor(width) + 'px';
            canvas.style.height = canvas.parentNode.style.height = div.style.height =
                    Math.floor(height) + 'px';
            // The canvas may have been originally rotated, rotate relative to that.
            var relativeRotation = this.viewport.rotation - canvas._viewport.rotation;
            var absRotation = Math.abs(relativeRotation);
            var scaleX = 1, scaleY = 1;
            if (absRotation === 90 || absRotation === 270) {
                // Scale x and y because of the rotation.
                scaleX = height / width;
                scaleY = width / height;
            }
            var cssTransform = 'rotate(' + relativeRotation + 'deg) ' +
                    'scale(' + scaleX + ',' + scaleY + ')';
            CustomStyle.setProp('transform', canvas, cssTransform);

            if (this.textLayer) {
                // Rotating the text layer is more complicated since the divs inside the
                // the text layer are rotated.
                // TODO: This could probably be simplified by drawing the text layer in
                // one orientation then rotating overall.
                var textLayerViewport = this.textLayer.viewport;
                var textRelativeRotation = this.viewport.rotation -
                        textLayerViewport.rotation;
                var textAbsRotation = Math.abs(textRelativeRotation);
                var scale = width / textLayerViewport.width;
                if (textAbsRotation === 90 || textAbsRotation === 270) {
                    scale = width / textLayerViewport.height;
                }
                var textLayerDiv = this.textLayer.textLayerDiv;
                var transX, transY;
                switch (textAbsRotation) {
                    case 0:
                        transX = transY = 0;
                        break;
                    case 90:
                        transX = 0;
                        transY = '-' + textLayerDiv.style.height;
                        break;
                    case 180:
                        transX = '-' + textLayerDiv.style.width;
                        transY = '-' + textLayerDiv.style.height;
                        break;
                    case 270:
                        transX = '-' + textLayerDiv.style.width;
                        transY = 0;
                        break;
                    default:
                        console.error('Bad rotation value.');
                        break;
                }
                CustomStyle.setProp('transform', textLayerDiv,
                        'rotate(' + textAbsRotation + 'deg) ' +
                        'scale(' + scale + ', ' + scale + ') ' +
                        'translate(' + transX + ', ' + transY + ')');
                CustomStyle.setProp('transformOrigin', textLayerDiv, '0% 0%');
            }

            if (redrawAnnotations && this.annotationLayer) {
                this.annotationLayer.render(this.viewport, 'display');
            }
        },

        get width() {
            return this.viewport.width;
        },

        get height() {
            return this.viewport.height;
        },

        getPagePoint: function PDFPageView_getPagePoint(x, y) {
            return this.viewport.convertToPdfPoint(x, y);
        },

        draw: function PDFPageView_draw() {
            if (this.renderingState !== RenderingStates.INITIAL) {
                console.error('Must be in new state before drawing');
            }

            this.renderingState = RenderingStates.RUNNING;

            var pdfPage = this.pdfPage;
            var viewport = this.viewport;
            var div = this.div;
            // Wrap the canvas so if it has a css transform for highdpi the overflow
            // will be hidden in FF.
            var canvasWrapper = document.createElement('div');
            canvasWrapper.style.width = div.style.width;
            canvasWrapper.style.height = div.style.height;
            canvasWrapper.classList.add('canvasWrapper');

            var canvas = document.createElement('canvas');
            canvas.id = 'page' + this.id;
            // Keep the canvas hidden until the first draw callback, or until drawing
            // is complete when `!this.renderingQueue`, to prevent black flickering.
            canvas.setAttribute('hidden', 'hidden');
            var isCanvasHidden = true;

            canvasWrapper.appendChild(canvas);
            if (this.annotationLayer && this.annotationLayer.div) {
                // annotationLayer needs to stay on top
                div.insertBefore(canvasWrapper, this.annotationLayer.div);
            } else {
                div.appendChild(canvasWrapper);
            }
            this.canvas = canvas;

            canvas.mozOpaque = true;
            var ctx = canvas.getContext('2d', {alpha: false});
            var outputScale = getOutputScale(ctx);
            this.outputScale = outputScale;

            if (PDFJS.useOnlyCssZoom) {
                var actualSizeViewport = viewport.clone({scale: CSS_UNITS});
                // Use a scale that will make the canvas be the original intended size
                // of the page.
                outputScale.sx *= actualSizeViewport.width / viewport.width;
                outputScale.sy *= actualSizeViewport.height / viewport.height;
                outputScale.scaled = true;
            }

            if (PDFJS.maxCanvasPixels > 0) {
                var pixelsInViewport = viewport.width * viewport.height;
                var maxScale =
                        Math.sqrt(PDFJS.maxCanvasPixels / pixelsInViewport);
                if (outputScale.sx > maxScale || outputScale.sy > maxScale) {
                    outputScale.sx = maxScale;
                    outputScale.sy = maxScale;
                    outputScale.scaled = true;
                    this.hasRestrictedScaling = true;
                } else {
                    this.hasRestrictedScaling = false;
                }
            }

            var sfx = approximateFraction(outputScale.sx);
            var sfy = approximateFraction(outputScale.sy);
            canvas.width = roundToDivide(viewport.width * outputScale.sx, sfx[0]);
            canvas.height = roundToDivide(viewport.height * outputScale.sy, sfy[0]);
            canvas.style.width = roundToDivide(viewport.width, sfx[1]) + 'px';
            canvas.style.height = roundToDivide(viewport.height, sfy[1]) + 'px';
            // Add the viewport so it's known what it was originally drawn with.
            canvas._viewport = viewport;

            var textLayerDiv = null;
            var textLayer = null;
            if (this.textLayerFactory) {
                textLayerDiv = document.createElement('div');
                textLayerDiv.className = 'textLayer';
                textLayerDiv.style.width = canvasWrapper.style.width;
                textLayerDiv.style.height = canvasWrapper.style.height;
                if (this.annotationLayer && this.annotationLayer.div) {
                    // annotationLayer needs to stay on top
                    div.insertBefore(textLayerDiv, this.annotationLayer.div);
                } else {
                    div.appendChild(textLayerDiv);
                }

                textLayer = this.textLayerFactory.createTextLayerBuilder(textLayerDiv, this.id - 1, this.viewport,
                        this.enhanceTextSelection);
            }
            this.textLayer = textLayer;

            var resolveRenderPromise, rejectRenderPromise;
            var promise = new Promise(function (resolve, reject) {
                resolveRenderPromise = resolve;
                rejectRenderPromise = reject;
            });

            // Rendering area

            var self = this;

            function pageViewDrawCallback(error) {
                // The renderTask may have been replaced by a new one, so only remove
                // the reference to the renderTask if it matches the one that is
                // triggering this callback.
                if (renderTask === self.renderTask) {
                    self.renderTask = null;
                }

                if (error === 'cancelled') {
                    rejectRenderPromise(error);
                    return;
                }

                self.renderingState = RenderingStates.FINISHED;

                if (isCanvasHidden) {
                    self.canvas.removeAttribute('hidden');
                    isCanvasHidden = false;
                }

                if (self.loadingIconDiv) {
                    div.removeChild(self.loadingIconDiv);
                    delete self.loadingIconDiv;
                }

                if (self.zoomLayer) {
                    // Zeroing the width and height causes Firefox to release graphics
                    // resources immediately, which can greatly reduce memory consumption.
                    var zoomLayerCanvas = self.zoomLayer.firstChild;
                    zoomLayerCanvas.width = 0;
                    zoomLayerCanvas.height = 0;

                    if (div.contains(self.zoomLayer)) {
                        // Prevent "Node was not found" errors if the `zoomLayer` was
                        // already removed. This may occur intermittently if the scale
                        // changes many times in very quick succession.
                        div.removeChild(self.zoomLayer);
                    }
                    self.zoomLayer = null;
                }

                self.error = error;
                self.stats = pdfPage.stats;
                if (self.onAfterDraw) {
                    self.onAfterDraw();
                }
//                        self.eventBus.dispatch('pagerendered', {
//                            source: self,
//                            pageNumber: self.id,
//                            cssTransform: false,
//                        });

                if (!error) {
                    resolveRenderPromise(undefined);
                } else {
                    rejectRenderPromise(error);
                }
            }

            var renderContinueCallback = null;
            if (this.renderingQueue) {
                renderContinueCallback = function renderContinueCallback(cont) {
                    if (!self.renderingQueue.isHighestPriority(self)) {
                        self.renderingState = RenderingStates.PAUSED;
                        self.resume = function resumeCallback() {
                            self.renderingState = RenderingStates.RUNNING;
                            cont();
                        };
                        return;
                    }
                    if (isCanvasHidden) {
                        self.canvas.removeAttribute('hidden');
                        isCanvasHidden = false;
                    }
                    cont();
                };
            }

            var transform = !outputScale.scaled ? null :
                    [outputScale.sx, 0, 0, outputScale.sy, 0, 0];
            var renderContext = {
                canvasContext: ctx,
                transform: transform,
                viewport: this.viewport,
                renderInteractiveForms: this.renderInteractiveForms,
                // intent: 'default', // === 'display'
            };
            var renderTask = this.renderTask = this.pdfPage.render(renderContext);
            renderTask.onContinue = renderContinueCallback;

            this.renderTask.promise.then(
                    function pdfPageRenderCallback() {
                        pageViewDrawCallback(null);
                        if (textLayer) {
                            self.pdfPage.getTextContent({
                                normalizeWhitespace: true,
                            }).then(function textContentResolved(textContent) {
                                textLayer.setTextContent(textContent);
                                textLayer.render(TEXT_LAYER_RENDER_DELAY);
                            });
                        }
                    },
                    function pdfPageRenderError(error) {
                        pageViewDrawCallback(error);
                    }
            );

            if (this.annotationLayerFactory) {
                if (!this.annotationLayer) {
                    this.annotationLayer = this.annotationLayerFactory.createAnnotationLayerBuilder(div, this.pdfPage,
                            this.renderInteractiveForms);
                }
                this.annotationLayer.render(this.viewport, 'display');
            }
            div.setAttribute('data-loaded', true);

            if (self.onBeforeDraw) {
                self.onBeforeDraw();
            }
            return promise;
        },

        beforePrint: function PDFPageView_beforePrint(printContainer) {
            var CustomStyle = PDFJS.CustomStyle;
            var pdfPage = this.pdfPage;

            var viewport = pdfPage.getViewport(1);
            // Use the same hack we use for high dpi displays for printing to get
            // better output until bug 811002 is fixed in FF.
            var PRINT_OUTPUT_SCALE = 2;
            var canvas = document.createElement('canvas');

            // The logical size of the canvas.
            canvas.width = Math.floor(viewport.width) * PRINT_OUTPUT_SCALE;
            canvas.height = Math.floor(viewport.height) * PRINT_OUTPUT_SCALE;

            // The rendered size of the canvas, relative to the size of canvasWrapper.
            canvas.style.width = (PRINT_OUTPUT_SCALE * 100) + '%';

            var cssScale = 'scale(' + (1 / PRINT_OUTPUT_SCALE) + ', ' +
                    (1 / PRINT_OUTPUT_SCALE) + ')';
            CustomStyle.setProp('transform', canvas, cssScale);
            CustomStyle.setProp('transformOrigin', canvas, '0% 0%');

            var canvasWrapper = document.createElement('div');
            canvasWrapper.appendChild(canvas);
            printContainer.appendChild(canvasWrapper);

            canvas.mozPrintCallback = function (obj) {
                var ctx = obj.context;

                ctx.save();
                ctx.fillStyle = 'rgb(255, 255, 255)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.restore();
                // Used by the mozCurrentTransform polyfill in src/display/canvas.js.
                ctx._transformMatrix =
                        [PRINT_OUTPUT_SCALE, 0, 0, PRINT_OUTPUT_SCALE, 0, 0];
                ctx.scale(PRINT_OUTPUT_SCALE, PRINT_OUTPUT_SCALE);

                var renderContext = {
                    canvasContext: ctx,
                    viewport: viewport,
                    intent: 'print'
                };

                pdfPage.render(renderContext).promise.then(function () {
                    // Tell the printEngine that rendering this canvas/page has finished.
                    obj.done();
                }, function (error) {
                    console.error(error);
                    // Tell the printEngine that rendering this canvas/page has failed.
                    // This will make the print process stop.
                    if ('abort' in obj) {
                        obj.abort();
                    } else {
                        obj.done();
                    }
                });
            };
        },
    };

    return PDFPageView;
})();
function approximateFraction(x) {
    // Fast paths for int numbers or their inversions.
    if (Math.floor(x) === x) {
        return [x, 1];
    }
    var xinv = 1 / x;
    var limit = 8;
    if (xinv > limit) {
        return [1, limit];
    } else if (Math.floor(xinv) === xinv) {
        return [1, xinv];
    }

    var x_ = x > 1 ? xinv : x;
    // a/b and c/d are neighbours in Farey sequence.
    var a = 0, b = 1, c = 1, d = 1;
    // Limiting search to order 8.
    while (true) {
        // Generating next term in sequence (order of q).
        var p = a + c, q = b + d;
        if (q > limit) {
            break;
        }
        if (x_ <= p / q) {
            c = p;
            d = q;
        } else {
            a = p;
            b = q;
        }
    }
    // Select closest of the neighbours to x.
    if (x_ - a / b < c / d - x_) {
        return x_ === x ? [a, b] : [b, a];
    } else {
        return x_ === x ? [c, d] : [d, c];
    }
}
function roundToDivide(x, div) {
    var r = x % div;
    return r === 0 ? x : Math.round(x - r + div);
}
var SimpleLinkService = (function SimpleLinkServiceClosure() {
    function SimpleLinkService() {
    }

    SimpleLinkService.prototype = {
        /**
         * @returns {number}
         */
        get page() {
            return 0;
        },
        /**
         * @param {number} value
         */
        set page(value) {
        },
        /**
         * @param dest - The PDF destination object.
         */
        navigateTo: function (dest) {
        },
        /**
         * @param dest - The PDF destination object.
         * @returns {string} The hyperlink to the PDF object.
         */
        getDestinationHash: function (dest) {
            return '#';
        },
        /**
         * @param hash - The PDF parameters/hash.
         * @returns {string} The hyperlink to the PDF object.
         */
        getAnchorUrl: function (hash) {
            return '#';
        },
        /**
         * @param {string} hash
         */
        setHash: function (hash) {
        },
        /**
         * @param {string} action
         */
        executeNamedAction: function (action) {
        },
        /**
         * @param {number} pageNum - page number.
         * @param {Object} pageRef - reference to the page.
         */
        cachePageRef: function (pageNum, pageRef) {
        }
    };
    return SimpleLinkService;
})();
var AnnotationLayerBuilder = (function AnnotationLayerBuilderClosure() {
    /**
     * @param {AnnotationLayerBuilderOptions} options
     * @constructs AnnotationLayerBuilder
     */
    function AnnotationLayerBuilder(options) {
        this.pageDiv = options.pageDiv;
        this.pdfPage = options.pdfPage;
        this.renderInteractiveForms = options.renderInteractiveForms;
        this.linkService = options.linkService;
        this.downloadManager = options.downloadManager;

        this.div = null;
    }

    AnnotationLayerBuilder.prototype =
            /** @lends AnnotationLayerBuilder.prototype */ {

        /**
         * @param {PageViewport} viewport
         * @param {string} intent (default value is 'display')
         */
        render: function AnnotationLayerBuilder_render(viewport, intent) {
            var self = this;
            var parameters = {
                intent: (intent === undefined ? 'display' : intent),
            };

            this.pdfPage.getAnnotations(parameters).then(function (annotations) {
                viewport = viewport.clone({dontFlip: true});
                parameters = {
                    viewport: viewport,
                    div: self.div,
                    annotations: annotations,
                    page: self.pdfPage,
                    renderInteractiveForms: self.renderInteractiveForms,
                    linkService: self.linkService,
                    downloadManager: self.downloadManager,
                };

                if (self.div) {
                    // If an annotationLayer already exists, refresh its children's
                    // transformation matrices.
                    PDFJS.AnnotationLayer.update(parameters);
                } else {
                    // Create an annotation layer div and render the annotations
                    // if there is at least one annotation.
                    if (annotations.length === 0) {
                        return;
                    }

                    self.div = document.createElement('div');
                    self.div.className = 'annotationLayer';
                    self.pageDiv.appendChild(self.div);
                    parameters.div = self.div;

                    PDFJS.AnnotationLayer.render(parameters);
                    if (typeof mozL10n !== 'undefined') {
                        mozL10n.translate(self.div);
                    }
                }
            });
        },

        hide: function AnnotationLayerBuilder_hide() {
            if (!this.div) {
                return;
            }
            this.div.setAttribute('hidden', 'true');
        }
    };

    return AnnotationLayerBuilder;
})();

/**
 * @constructor
 * @implements IPDFAnnotationLayerFactory
 */
function DefaultAnnotationLayerFactory() {
}
DefaultAnnotationLayerFactory.prototype = {
    /**
     * @param {HTMLDivElement} pageDiv
     * @param {PDFPage} pdfPage
     * @param {boolean} renderInteractiveForms
     * @returns {AnnotationLayerBuilder}
     */
    createAnnotationLayerBuilder: function (pageDiv, pdfPage,
                                            renderInteractiveForms) {
        return new AnnotationLayerBuilder({
            pageDiv: pageDiv,
            pdfPage: pdfPage,
            renderInteractiveForms: renderInteractiveForms,
            linkService: new SimpleLinkService(),
        });
    }
};
var TextLayerBuilder = (function TextLayerBuilderClosure() {
    function TextLayerBuilder(options) {
        this.textLayerDiv = options.textLayerDiv;
        //this.eventBus = options.eventBus || domEvents.getGlobalEventBus();
        this.renderingDone = false;
        this.divContentDone = false;
        this.pageIdx = options.pageIndex;
        this.pageNumber = this.pageIdx + 1;
        this.matches = [];
        this.viewport = options.viewport;
        this.textDivs = [];
        this.findController = options.findController || null;
        this.textLayerRenderTask = null;
        this.enhanceTextSelection = options.enhanceTextSelection;
        this._bindMouse();
    }

    TextLayerBuilder.prototype = {
        _finishRendering: function TextLayerBuilder_finishRendering() {
            this.renderingDone = true;

            if (!this.enhanceTextSelection) {
                var endOfContent = document.createElement('div');
                endOfContent.className = 'endOfContent';
                this.textLayerDiv.appendChild(endOfContent);
            }

//                    this.eventBus.dispatch('textlayerrendered', {
//                        source: this,
//                        pageNumber: this.pageNumber
//                    });
        },

        /**
         * Renders the text layer.
         * @param {number} timeout (optional) if specified, the rendering waits
         *   for specified amount of ms.
         */
        render: function TextLayerBuilder_render(timeout) {
            if (!this.divContentDone || this.renderingDone) {
                return;
            }

            if (this.textLayerRenderTask) {
                this.textLayerRenderTask.cancel();
                this.textLayerRenderTask = null;
            }

            this.textDivs = [];
            var textLayerFrag = document.createDocumentFragment();
            this.textLayerRenderTask = PDFJS.renderTextLayer({
                textContent: this.textContent,
                container: textLayerFrag,
                viewport: this.viewport,
                textDivs: this.textDivs,
                timeout: timeout,
                enhanceTextSelection: this.enhanceTextSelection,
            });
            this.textLayerRenderTask.promise.then(function () {
                this.textLayerDiv.appendChild(textLayerFrag);
                this._finishRendering();
                this.updateMatches();
            }.bind(this), function (reason) {
                // canceled or failed to render text layer -- skipping errors
            });
        },

        setTextContent: function TextLayerBuilder_setTextContent(textContent) {
            if (this.textLayerRenderTask) {
                this.textLayerRenderTask.cancel();
                this.textLayerRenderTask = null;
            }
            this.textContent = textContent;
            this.divContentDone = true;
        },

        convertMatches: function TextLayerBuilder_convertMatches(matches,
                                                                 matchesLength) {
            var i = 0;
            var iIndex = 0;
            var bidiTexts = this.textContent.items;
            var end = bidiTexts.length - 1;
            var queryLen = (this.findController === null ?
                    0 : this.findController.state.query.length);
            var ret = [];
            if (!matches) {
                return ret;
            }
            for (var m = 0, len = matches.length; m < len; m++) {
                // Calculate the start position.
                var matchIdx = matches[m];

                // Loop over the divIdxs.
                while (i !== end && matchIdx >= (iIndex + bidiTexts[i].str.length)) {
                    iIndex += bidiTexts[i].str.length;
                    i++;
                }

                if (i === bidiTexts.length) {
                    console.error('Could not find a matching mapping');
                }

                var match = {
                    begin: {
                        divIdx: i,
                        offset: matchIdx - iIndex
                    }
                };

                // Calculate the end position.
                if (matchesLength) { // multiterm search
                    matchIdx += matchesLength[m];
                } else { // phrase search
                    matchIdx += queryLen;
                }

                // Somewhat the same array as above, but use > instead of >= to get
                // the end position right.
                while (i !== end && matchIdx > (iIndex + bidiTexts[i].str.length)) {
                    iIndex += bidiTexts[i].str.length;
                    i++;
                }

                match.end = {
                    divIdx: i,
                    offset: matchIdx - iIndex
                };
                ret.push(match);
            }

            return ret;
        },

        renderMatches: function TextLayerBuilder_renderMatches(matches) {
            // Early exit if there is nothing to render.
            if (matches.length === 0) {
                return;
            }

            var bidiTexts = this.textContent.items;
            var textDivs = this.textDivs;
            var prevEnd = null;
            var pageIdx = this.pageIdx;
            var isSelectedPage = (this.findController === null ?
                    false : (pageIdx === this.findController.selected.pageIdx));
            var selectedMatchIdx = (this.findController === null ?
                    -1 : this.findController.selected.matchIdx);
            var highlightAll = (this.findController === null ?
                    false : this.findController.state.highlightAll);
            var infinity = {
                divIdx: -1,
                offset: undefined
            };

            function beginText(begin, className) {
                var divIdx = begin.divIdx;
                textDivs[divIdx].textContent = '';
                appendTextToDiv(divIdx, 0, begin.offset, className);
            }

            function appendTextToDiv(divIdx, fromOffset, toOffset, className) {
                var div = textDivs[divIdx];
                var content = bidiTexts[divIdx].str.substring(fromOffset, toOffset);
                var node = document.createTextNode(content);
                if (className) {
                    var span = document.createElement('span');
                    span.className = className;
                    span.appendChild(node);
                    div.appendChild(span);
                    return;
                }
                div.appendChild(node);
            }

            var i0 = selectedMatchIdx, i1 = i0 + 1;
            if (highlightAll) {
                i0 = 0;
                i1 = matches.length;
            } else if (!isSelectedPage) {
                // Not highlighting all and this isn't the selected page, so do nothing.
                return;
            }

            for (var i = i0; i < i1; i++) {
                var match = matches[i];
                var begin = match.begin;
                var end = match.end;
                var isSelected = (isSelectedPage && i === selectedMatchIdx);
                var highlightSuffix = (isSelected ? ' selected' : '');

                if (this.findController) {
                    this.findController.updateMatchPosition(pageIdx, i, textDivs,
                            begin.divIdx);
                }

                // Match inside new div.
                if (!prevEnd || begin.divIdx !== prevEnd.divIdx) {
                    // If there was a previous div, then add the text at the end.
                    if (prevEnd !== null) {
                        appendTextToDiv(prevEnd.divIdx, prevEnd.offset, infinity.offset);
                    }
                    // Clear the divs and set the content until the starting point.
                    beginText(begin);
                } else {
                    appendTextToDiv(prevEnd.divIdx, prevEnd.offset, begin.offset);
                }

                if (begin.divIdx === end.divIdx) {
                    appendTextToDiv(begin.divIdx, begin.offset, end.offset,
                            'highlight' + highlightSuffix);
                } else {
                    appendTextToDiv(begin.divIdx, begin.offset, infinity.offset,
                            'highlight begin' + highlightSuffix);
                    for (var n0 = begin.divIdx + 1, n1 = end.divIdx; n0 < n1; n0++) {
                        textDivs[n0].className = 'highlight middle' + highlightSuffix;
                    }
                    beginText(end, 'highlight end' + highlightSuffix);
                }
                prevEnd = end;
            }

            if (prevEnd) {
                appendTextToDiv(prevEnd.divIdx, prevEnd.offset, infinity.offset);
            }
        },

        updateMatches: function TextLayerBuilder_updateMatches() {
            // Only show matches when all rendering is done.
            if (!this.renderingDone) {
                return;
            }

            // Clear all matches.
            var matches = this.matches;
            var textDivs = this.textDivs;
            var bidiTexts = this.textContent.items;
            var clearedUntilDivIdx = -1;

            // Clear all current matches.
            for (var i = 0, len = matches.length; i < len; i++) {
                var match = matches[i];
                var begin = Math.max(clearedUntilDivIdx, match.begin.divIdx);
                for (var n = begin, end = match.end.divIdx; n <= end; n++) {
                    var div = textDivs[n];
                    div.textContent = bidiTexts[n].str;
                    div.className = '';
                }
                clearedUntilDivIdx = match.end.divIdx + 1;
            }

            if (this.findController === null || !this.findController.active) {
                return;
            }

            // Convert the matches on the page controller into the match format
            // used for the textLayer.
            var pageMatches, pageMatchesLength;
            if (this.findController !== null) {
                pageMatches = this.findController.pageMatches[this.pageIdx] || null;
                pageMatchesLength = (this.findController.pageMatchesLength) ?
                this.findController.pageMatchesLength[this.pageIdx] || null : null;
            }

            this.matches = this.convertMatches(pageMatches, pageMatchesLength);
            this.renderMatches(this.matches);
        },

        /**
         * Fixes text selection: adds additional div where mouse was clicked.
         * This reduces flickering of the content if mouse slowly dragged down/up.
         * @private
         */
        _bindMouse: function TextLayerBuilder_bindMouse() {
            var div = this.textLayerDiv;
            var self = this;
            var expandDivsTimer = null;
            div.addEventListener('mousedown', function (e) {
                if (self.enhanceTextSelection && self.textLayerRenderTask) {
                    self.textLayerRenderTask.expandTextDivs(true);
                    if (expandDivsTimer) {
                        clearTimeout(expandDivsTimer);
                        expandDivsTimer = null;
                    }
                    return;
                }
                var end = div.querySelector('.endOfContent');
                if (!end) {
                    return;
                }
                // On non-Firefox browsers, the selection will feel better if the height
                // of the endOfContent div will be adjusted to start at mouse click
                // location -- this will avoid flickering when selections moves up.
                // However it does not work when selection started on empty space.
                var adjustTop = e.target !== div;
                adjustTop = adjustTop && window.getComputedStyle(end).getPropertyValue('-moz-user-select') !== 'none';
                if (adjustTop) {
                    var divBounds = div.getBoundingClientRect();
                    var r = Math.max(0, (e.pageY - divBounds.top) / divBounds.height);
                    end.style.top = (r * 100).toFixed(2) + '%';
                }
                end.classList.add('active');
            });
            div.addEventListener('mouseup', function (e) {
                if (self.enhanceTextSelection && self.textLayerRenderTask) {
                    expandDivsTimer = setTimeout(function () {
                        self.textLayerRenderTask.expandTextDivs(false);
                        expandDivsTimer = null;
                    }, EXPAND_DIVS_TIMEOUT);
                    return;
                }
                var end = div.querySelector('.endOfContent');
                if (!end) {
                    return;
                }
                end.style.top = '';
                end.classList.remove('active');
            });
        },
    };
    return TextLayerBuilder;
})();