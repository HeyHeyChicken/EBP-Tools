// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

#include <iostream>
#include <filesystem>
#include <regex>
#include <list>
#include <tesseract/baseapi.h>
#include <nlohmann/json.hpp>

#ifdef _WIN32
    #include <opencv4/opencv2/opencv.hpp>
#else
    #include <opencv2/opencv.hpp>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

class RGB {
    public:
        // Attributs
        int r;
        int g;
        int b;

        // Constructeur
        RGB(int r, int g, int b) : r(r), g(g), b(b) {}
};

struct Player { int id; std::string name; };
class Team {
    public:
        // Attributs
        std::string name;
        std::vector<std::string> names;
        int score = -1;
        std::vector<Player> players;

        NLOHMANN_DEFINE_TYPE_INTRUSIVE(Team, name, score)
};
class End {
    public:
        // Attributs
        double time = -1;
        int elapsed = -1;

        NLOHMANN_DEFINE_TYPE_INTRUSIVE(End, time, elapsed)
};
class Game {
    public:
        // Attributs
        double start = -1;
        End end;
        std::string map;
        Team orangeTeam;
        Team blueTeam;
        bool __debug__jumped = false;

        NLOHMANN_DEFINE_TYPE_INTRUSIVE(Game, start, end, map, orangeTeam, blueTeam)
};
class Map {
    public:
        // Attributs
        std::string name;
        std::vector<std::string> dictionnary;

        // Constructeur
        Map(const std::string& name, const std::vector<std::string>& dictionnary)
            : name(name), dictionnary(dictionnary) {}
};

// Cette fonction retourne la valeur la plus présente dans une liste de string.
std::string getMostFrequent(const std::vector<std::string>& names) {
    std::unordered_map<std::string, int> freq;
    for (const auto& name : names)
        ++freq[name];

    return std::max_element(
        freq.begin(), freq.end(),
        [](const auto& a, const auto& b) { return a.second < b.second; }
    )->first;
}

std::string normalizePath(std::string path) {
    std::replace(path.begin(), path.end(), '\\', '/');
    return path;
}

//Fonction utilitaire pour mettre en minuscules.
std::string toLower(const std::string& str) {
    std::string out = str;
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c){ return std::tolower(c); });
    return out;
}

//Fonction utilitaire pour supprimer les retours à la ligne
std::string removeNewlines(const std::string& str) {
    std::string out;
    for (char c : str) {
        if (c != '\r' && c != '\n')
            out += c;
    }
    return out;
}

//Fonction utilitaire pour splitter une string par les espaces
std::vector<std::string> splitBySpace(const std::string& str) {
    std::vector<std::string> result;
    std::istringstream iss(str);
    for (std::string s; iss >> s; )
        result.push_back(s);
    return result;
}

//Cette fonction retourne le nom de la map correspondant à une description.
std::string getMapByName(const std::string& search) {
    const std::list<Map> MAPS = {
        Map("Artefact", {"artefact"}),
        Map("Atlantis", {"atlantis"}),
        Map("Ceres", {"ceres"}),
        Map("Engine", {"engine"}),
        Map("Helios Station", {"helios", "station"}),
        Map("Lunar Outpost", {"lunar", "outpost"}),
        Map("Outlaw", {"outlaw"}),
        Map("Polaris", {"polaris"}),
        Map("Silva", {"silva"}),
        Map("The Cliff", {"cliff"}),
        Map("The Rock", {"rock"})
    };

    // Nettoyage et découpage du texte de recherche
    std::string cleaned = removeNewlines(search);
    cleaned = toLower(cleaned);
    std::vector<std::string> splitted = splitBySpace(cleaned);

    // Recherche
    for (const auto& map : MAPS) {
        for (const auto& s : splitted) {
            if (std::find(map.dictionnary.begin(), map.dictionnary.end(), s) != map.dictionnary.end()) {
                return map.name;
            }
        }
    }
    return "";
}

// Cette fonction permet de définir si deux couleurs sont similaires.
bool colorSimilarity(const RGB& color1, const RGB& color2, int maxDifference = 20) {
    return
        std::abs(color1.r - color2.r) <= maxDifference &&
        std::abs(color1.g - color2.g) <= maxDifference &&
        std::abs(color1.b - color2.b) <= maxDifference;
}

// Cette fonction retourne la couleur RGBA du pixel d'une vidéo à une position donnée.
RGB getPixelColor(const cv::Mat& frame, int x, int y) {
    cv::Vec3b pixel = frame.at<cv::Vec3b>(y, x);
    return RGB((int)pixel[2], (int)pixel[1], (int)pixel[0]);
}

// Cette fonction détecte une fin de game via l'affichage du score.
bool detectGameScoreFrame(const cv::Mat& frame, const std::list<Game>& games, const bool debug) {
    if (games.empty() || games.front().start != -1) {
        if (
            colorSimilarity( // Logo orange
                getPixelColor(frame, 325, 153),
                RGB(239, 203, 14)
            ) &&
            colorSimilarity( // Logo bleu
                getPixelColor(frame, 313, 613),
                RGB(50, 138, 230)
            )
        ) {
            if(debug){
                //std::cout << "C - Game's score frame detected !" << std::endl;
            }
            return true;
        }
    }
    return false;
}

// Cette fonction détecte un début de game via l'affichage du loader d'EVA.
bool detectGameLoadingFrame(const cv::Mat& frame, const std::list<Game>& games, const bool debug) {
    if (!games.empty() && games.front().end.time != -1 && games.front().start == -1) {
        if (
            colorSimilarity( // Logo top
                getPixelColor(frame, 958, 427),
                RGB(255, 255, 255)
            ) &&
            colorSimilarity( // Logo left
                getPixelColor(frame, 857, 653),
                RGB(255, 255, 255)
            ) &&
            colorSimilarity( // Logo right
                getPixelColor(frame, 1060, 653),
                RGB(255, 255, 255)
            ) &&
            colorSimilarity( // Logo middle
                getPixelColor(frame, 958, 642),
                RGB(255, 255, 255)
            ) &&
            colorSimilarity( // Logo black 1
                getPixelColor(frame, 958, 463),
                RGB(0, 0, 0)
            ) &&
            colorSimilarity( // Logo black 2
                getPixelColor(frame, 880, 653),
                RGB(0, 0, 0)
            ) &&
            colorSimilarity( // Logo black 3
                getPixelColor(frame, 1037, 653),
                RGB(0, 0, 0)
            ) &&
            colorSimilarity( // Logo black 4
                getPixelColor(frame, 958, 610),
                RGB(0, 0, 0)
            )
        ) {
            if(debug){
                //std::cout << "C - Game's loading frame detected !" << std::endl;
            }
            return true;
        }
    }
    return false;
}

// Cette fonction détecte un début de game via l'introduction de la map.
bool detectGameIntro(const cv::Mat& frame, const std::list<Game>& games, const bool debug) {
    if (!games.empty() && games.front().end.time != -1 && games.front().start == -1) {
        // On essaie de détecter le "B" du "BATTLE ARENA" en bas à droite de l'image.
        if (
            //#region B1
            (colorSimilarity(getPixelColor(frame, 1495, 942), RGB(255, 255, 255), 30) &&
                colorSimilarity(
                    getPixelColor(frame, 1512, 950),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1495, 962),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1512, 972),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1495, 982),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(getPixelColor(frame, 1503, 951), RGB(0, 0, 0), 200) &&
                colorSimilarity(getPixelColor(frame, 1503, 972), RGB(0, 0, 0), 200)) ||
            //#endregion
            //#region B2
            (colorSimilarity(getPixelColor(frame, 1558, 960), RGB(255, 255, 255), 30) &&
                colorSimilarity(
                    getPixelColor(frame, 1572, 968),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1558, 977),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1572, 987),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1558, 995),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(getPixelColor(frame, 1564, 969), RGB(0, 0, 0), 200) &&
                colorSimilarity(getPixelColor(frame, 1564, 986), RGB(0, 0, 0), 200)) ||
            //#endregion
            //#region B3
            (colorSimilarity(getPixelColor(frame, 1556, 957), RGB(255, 255, 255), 30) &&
                colorSimilarity(
                    getPixelColor(frame, 1571, 964),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1556, 975),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1571, 984),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1556, 993),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(getPixelColor(frame, 1564, 966), RGB(0, 0, 0), 200) &&
                colorSimilarity(getPixelColor(frame, 1564, 984), RGB(0, 0, 0), 200)) ||
            //#endregion
            //#region B4
            (colorSimilarity(getPixelColor(frame, 1617, 979), RGB(255, 255, 255), 30) &&
                colorSimilarity(
                    getPixelColor(frame, 1630, 985),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1617, 995),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1630, 1004),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1617, 1011),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(getPixelColor(frame, 1623, 987), RGB(0, 0, 0), 200) &&
                colorSimilarity(getPixelColor(frame, 1623, 1004), RGB(0, 0, 0), 200)) ||
            //#endregion
            //#region B5
            (colorSimilarity(getPixelColor(frame, 1606, 976), RGB(255, 255, 255), 30) &&
                colorSimilarity(
                    getPixelColor(frame, 1619, 982),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1606, 991),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1619, 1000),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(
                    getPixelColor(frame, 1606, 1008),
                    RGB(255, 255, 255),
                    30
                ) &&
                colorSimilarity(getPixelColor(frame, 1612, 983), RGB(0, 0, 0), 200) &&
                colorSimilarity(getPixelColor(frame, 1612, 1000), RGB(0, 0, 0), 200))
            //#endregion
        ) {
            if(debug){
                //std::cout << "A - Game's intro frame detected !" << std::endl;
            }
            return true;
        }
    }
    return false;
}

// Cette fonction détecte une frame de gameplay.
bool detectGamePlaying(const cv::Mat& frame, const std::list<Game>& games, const bool debug) {
    if (!games.empty() && games.front().start == -1) {
        // On essaie de détecter la couleur des barres de vie de tout les joueurs.
        const RGB J1_PIXEL = getPixelColor(frame, 118, 742);
        const RGB J2_PIXEL = getPixelColor(frame, 118, 825);
        const RGB J3_PIXEL = getPixelColor(frame, 118, 907);
        const RGB J4_PIXEL = getPixelColor(frame, 118, 991);
        const RGB J5_PIXEL = getPixelColor(frame, 1801, 742);
        const RGB J6_PIXEL = getPixelColor(frame, 1801, 825);
        const RGB J7_PIXEL = getPixelColor(frame, 1801, 907);
        const RGB J8_PIXEL = getPixelColor(frame, 1801, 991);
        if (
            //#region Orange team
            // Joueur 1
            (colorSimilarity(J1_PIXEL, RGB(231, 123, 9)) ||
                colorSimilarity(J1_PIXEL, RGB(0, 0, 0), 50)) &&
            // Joueur 2
            (colorSimilarity(J2_PIXEL, RGB(231, 123, 9)) ||
                colorSimilarity(J2_PIXEL, RGB(0, 0, 0), 50)) &&
            // Joueur 3
            (colorSimilarity(J3_PIXEL, RGB(231, 123, 9)) ||
                colorSimilarity(J3_PIXEL, RGB(0, 0, 0), 50)) &&
            //Joueur 4
            (colorSimilarity(J4_PIXEL, RGB(231, 123, 9)) ||
                colorSimilarity(J4_PIXEL, RGB(0, 0, 0), 50)) &&
            //#endregion
            //#region Blue team
            //Joueur 1
            (colorSimilarity(J5_PIXEL, RGB(30, 126, 242)) ||
                colorSimilarity(J5_PIXEL, RGB(0, 0, 0), 50)) &&
            // Joueur 2
            (colorSimilarity(J6_PIXEL, RGB(30, 126, 242)) ||
                colorSimilarity(J6_PIXEL, RGB(0, 0, 0), 50)) &&
            // Joueur 3
            (colorSimilarity(J7_PIXEL, RGB(30, 126, 242)) ||
                colorSimilarity(J7_PIXEL, RGB(0, 0, 0), 50)) &&
            // Joueur 4
            (colorSimilarity(J8_PIXEL, RGB(30, 126, 242)) ||
                colorSimilarity(J8_PIXEL, RGB(0, 0, 0), 50))
            //#endregion
        ) {
            if(debug){
                //std::cout << "B - Game's playing frame detected !" << std::endl;
            }
            return true;
        }
        return false;
    }
    return false;
}

// Cette fonction retourne avec de l'OCR le texte présent dans une région d'une frame.
std::string getTextFromImage(const cv::Mat& frame, tesseract::TessBaseAPI& tess, int x1, int y1, int x2, int y2, int tesseditPagesegMode = 3, int imageModeIndex = 0) {
    // Vérification des bornes
    if (x1 < 0 || y1 < 0 || x2 > frame.cols || y2 > frame.rows || x2 <= x1 || y2 <= y1) {
        throw std::invalid_argument("Coordonnées du rectangle invalides.");
    }
    cv::Mat copy;
    if(imageModeIndex >= 1){
        copy = frame.clone();
        // Convertir en niveaux de gris, écrase copy
        cv::cvtColor(copy, copy, cv::COLOR_BGR2GRAY);
        copy.convertTo(copy, -1, 1, 1);
    }
    
    if(imageModeIndex == 2){
        cv::bitwise_not(copy, copy);
    }
    const cv::Mat& target = (copy.empty()) ? frame : copy;

    // Extraction de la région d'intérêt
    cv::Rect roi(x1, y1, x2 - x1, y2 - y1);
    cv::Mat subImage = target(roi);

    //cv::imwrite("debug_" + std::to_string(x1) + "_" + std::to_string(imageModeIndex) + ".png", subImage);

    tess.SetPageSegMode(static_cast<tesseract::PageSegMode>(tesseditPagesegMode));
    tess.SetImage(subImage.data, subImage.cols, subImage.rows, subImage.channels(), subImage.step);

    char* out = tess.GetUTF8Text();
    std::string result(out ? out : "");
    delete[] out;

    // Suppression des '\n'
    result = removeNewlines(result);

    //std::cout << "{\"aaa\":" << imageModeIndex << ",\"x1\":" << x1 << ",\"result\":" << result << "}" << std::endl;
    if(result == "" && imageModeIndex < 2){
        return getTextFromImage(frame, tess, x1, y1, x2, y2, tesseditPagesegMode, imageModeIndex + 1);
    }
    else{
        return result;
    }
}

void replaceAllBackslashToSlash(std::string& path) {
    std::replace(path.begin(), path.end(), '\\', '/');
}

// Cette fonction retourne la liste des games présentes dans une vidéo.
std::list<Game> getGames(const fs::path& videoPath, const int duration, const bool debug) {
    std::list<Game> games = {};

    std::string videoPathString = videoPath.string();
    #ifdef _WIN32
        replaceAllBackslashToSlash(videoPathString);
    #endif

    cv::VideoCapture cap(videoPathString);
    if (!cap.isOpened()) {
        if(debug){
            std::cerr << "Impossible d'ouvrir la vidéo." << std::endl;
        }
        return games;
    }

    tesseract::TessBaseAPI tess;
    if (tess.Init(NULL, "eng")) {
        throw std::runtime_error("Impossible d'initialiser Tesseract.");
    }
    tess.SetVariable("tessedit_char_whitelist", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-:% 1234567890");

    // Tesseract - Number 
    tesseract::TessBaseAPI tessNumber;
    if (tessNumber.Init(NULL, "eng")) {
        throw std::runtime_error("Impossible d'initialiser Tesseract.");
    }
    tessNumber.SetVariable("tessedit_char_whitelist", "1234567890");

    const int TOTAL_FRAMES = static_cast<int>(cap.get(cv::CAP_PROP_FRAME_COUNT));
    const int FPS = TOTAL_FRAMES / duration;
    const int JUMP = 2;
    int oldPercent = 0;
    const int TEAM_NAME_ERROR_ARRAY_SIZE = 10;
    if(debug){
        //std::cout << "La vidéo est réglée en " << FPS << " FPS." << std::endl;
    }
    for (int i = TOTAL_FRAMES - 1; i >= 0; i -= FPS * JUMP) {
        const int NEW_PERCENT = 100 - (i * 100 / TOTAL_FRAMES);
        if(NEW_PERCENT > oldPercent){
            oldPercent = NEW_PERCENT;
            std::cout << "{\"percent\":" << NEW_PERCENT << "}" << std::endl;
        }
        bool found = false;

        cap.set(cv::CAP_PROP_POS_FRAMES, i);
        cv::Mat frame;
        if (!cap.read(frame) || frame.empty()) continue;

        // On détecte les écrans de score.
        if(!found && detectGameScoreFrame(frame, games, debug)){
            found = true;
            
            Game game;
            game.end.time = std::round(cap.get(cv::CAP_PROP_POS_MSEC) / 1000.0);

            //cv::imwrite("output_" + std::to_string(i) + ".png", frame);

            const std::string ORANGE_SCORE = getTextFromImage(
                frame,
                tessNumber,
                530,
                89,
                620,
                127,
                7
            );
            if(ORANGE_SCORE != ""){
                game.orangeTeam.score = std::stoi(ORANGE_SCORE);
            }

            const std::string BLUE_SCORE = getTextFromImage(
                frame,
                tessNumber,
                1294,
                89,
                1384,
                127,
                7
            );
            if(BLUE_SCORE != ""){
                game.blueTeam.score = std::stoi(BLUE_SCORE);
            }

            const std::string ELAPSED = getTextFromImage(
                frame,
                tessNumber,
                70,
                60,
                190,
                140,
                7
            );
            if(ELAPSED != ""){
                game.end.elapsed = std::stoi(ELAPSED);
            }

            games.push_front(game);
            i -= 30 * FPS; // On coupe les 30 dernières secondes de la game.
        }

        // On détecte les écrans de début de game.
        if(!found && detectGameLoadingFrame(frame, games, debug)){
            found = true;
            games.front().start = std::round(cap.get(cv::CAP_PROP_POS_MSEC) / 1000.0) + 2; // On vire le bout de loader de map.
        }
        if(!found && detectGameIntro(frame, games, debug)){
            found = true;
            games.front().start = std::round(cap.get(cv::CAP_PROP_POS_MSEC) / 1000.0) + 2; // On vire le bout de loader de map.
        }

        // Détéction du nom de la carte en cours de partie.
        if(!found && detectGamePlaying(frame, games, debug)){
            // On récupère le nom de la carte.
            if(games.front().map == ""){
                const std::string MAP_NAME = getMapByName(getTextFromImage(
                    frame,
                    tess,
                    825,
                    81,
                    1093,
                    102,
                    7
                ));
                if(MAP_NAME != ""){
                    games.front().map = MAP_NAME;
                }
            }

            if(games.front().orangeTeam.names.size() < TEAM_NAME_ERROR_ARRAY_SIZE){
                // On récupère le nom de l'équipe orange.
                const std::string TEXT = getTextFromImage(
                    frame,
                    tess,
                    686,
                    22,
                    833,
                    68,
                    6
                );
                if(TEXT.length() >= 2){
                    games.front().orangeTeam.names.push_back(TEXT);
                }
            }
            else if(games.front().orangeTeam.name == ""){
                games.front().orangeTeam.name = getMostFrequent(games.front().orangeTeam.names);
            }

            if(games.front().blueTeam.names.size() < TEAM_NAME_ERROR_ARRAY_SIZE){
                // On récupère le nom de l'équipe bleu.
                const std::string TEXT = getTextFromImage(
                    frame,
                    tess,
                    1087,
                    22,
                    1226,
                    68,
                    6
                );
                if(TEXT.length() >= 2){
                    games.front().blueTeam.names.push_back(TEXT);
                }
            }
            else if(games.front().blueTeam.name == ""){
                games.front().blueTeam.name = getMostFrequent(games.front().blueTeam.names);
            }

            // On a tout trouvé, on cherche à gagner du temps.
            if(!games.front().__debug__jumped && games.front().map != "" && games.front().orangeTeam.name != "" && games.front().blueTeam.name != ""){
                const std::string TEXT = getTextFromImage(
                    frame,
                    tess,
                    935,
                    0,
                    985,
                    28,
                    7
                );
                std::vector<std::string> SPLITTED;
                std::istringstream iss(TEXT);
                std::string part;
                while (std::getline(iss, part, ':')) {
                    SPLITTED.push_back(part);
                }

                if (SPLITTED.size() == 2) {
                    const int MINUTES = std::stoi(SPLITTED[0]);
                    const int SECONDES = std::stoi(SPLITTED[1]);
                    const int DIFFERENCE = (10 - MINUTES) * 60 - SECONDES;

                    std::cout << "{\"nbGames\":" << games.size() << "}" << std::endl;
                    if (MINUTES <= 9) {
                        games.front().__debug__jumped = true;
                        i -= DIFFERENCE * FPS;
                    }
                }

            }
        }
    }
    cap.release();
    return games;
}

void replaceAllSlashWithBackslash(std::string& str) {
    for (auto& ch : str) if (ch == '/') ch = '\\';
}

int main(int argc, char* argv[]) {
    // On verrifie qu'il y a le bon nombre de paramètres.
    if (argc != 6) {
        std::cerr << "Erreur : Veuillez fournir 4 parametres (1 - chemin de la video, 2 - nom du systeme d'exploitation, 3 - mode debug, 4 - chemin de ffmpeg, 5 - durée de la vidéo)." << std::endl;
        return 1;
    }

    const bool DEBUG = std::string(argv[3]) == "true";

    fs::path chemin(argv[1]);
    // On vérifie que l'extension est bien ".mp4".
    std::string ext = chemin.extension().string();
    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
    if (ext == ".mp4") {
        // On vérifie la résolution de la vidéo.
        std::string os = argv[2];
        std::string ffmpegPath = argv[4];
        std::string chemin_string = chemin.string();

        const double duration = std::stod(argv[5]);
        std::list<Game> games = getGames(chemin, duration, DEBUG);
        json j = games;
        std::cout << j.dump() << std::endl;
    } else {
        if(DEBUG){
            std::cerr << "Erreur : Le fichier n'est pas un MP4." << std::endl;
        }
        return 1;
    }
    return 0;
}